import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tools de ESCRITURA del CATÁLOGO que no entran en el proxy REST declarativo de
 * `toolDefinitions.ts`.
 *
 * # Por qué `update_material` vive acá
 *
 * `PUT /items/:id` es un update parcial salvo por un detalle: el controller del
 * backend hace `if (!Array.isArray(body.suppliers)) body.suppliers = []`. O sea,
 * CUALQUIER edición que no reenvíe los proveedores se los borra al artículo, en
 * silencio y sin aviso. Un proxy declarativo no puede evitarlo: no tiene forma
 * de saber qué proveedores tenía el artículo antes.
 *
 * Por eso esta tool lee el artículo primero (`GET /items/:id`), conserva sus
 * proveedores y recién entonces escribe. Ese mismo GET permite además resolver
 * el `costoUnitario` que el backend exige al pasar un ítem a subcontratado
 * "full" sin que el modelo tenga que acordarse del costo con el que se creó.
 */

const UpdateMaterialSchema = z.object({
  itemId: z.string().min(1).describe('ID del articulo a modificar (el _id que devuelve search_materials o create_material).'),
  name: z.string().optional().describe('Nombre del articulo.'),
  code: z.string().optional().describe('Codigo interno, unico dentro de la empresa.'),
  unit: z.string().optional().describe('Unidad de medida (kg, m2, ml, ud, ...).'),
  description: z.string().optional().describe('Descripcion detallada.'),
  classification: z.string().optional().describe('ID de la clasificacion (get_classifications, tipo "product_type").'),
  nature: z.enum(['material', 'item']).optional().describe('"material" (insumo de obra) o "item" (producto/partida).'),
  defaultCost: z.number().optional().describe('Costo unitario de referencia. Para subcontractMode "full" manda costoUnitario.'),
  subcontractMode: z
    .enum(['none', 'labor_only', 'full'])
    .optional()
    .describe(
      '"full" = 100% subcontratado: TODO el costo se imputa al rubro Subcontratado en vez de Materiales, y la orden de compra deja de exigir almacen. ' +
        '"labor_only" = solo la mano de obra es subcontratada. "none" = articulo propio.',
    ),
  costoUnitario: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Costo unitario del servicio subcontratado. El backend lo exige cuando el modo queda en "full": si no se manda, se reusa el que ya tenga el articulo ' +
        'y, si no tiene, su costo unitario actual (defaultCost). Se informa en la respuesta cuando se reusa.',
    ),
  minimumStock: z.number().min(0).optional().describe('Bajo este nivel el articulo figura como stock bajo.'),
})

interface StoredItem {
  _id?: string
  name?: string
  code?: string
  unit?: string
  defaultCost?: number
  costoUnitario?: number
  subcontractMode?: string
  subcontratado?: boolean
  suppliers?: unknown
  costBreakdown?: Record<string, number>
}

/**
 * Los proveedores vienen poblados del GET (`supplierId` es un objeto con `_id`,
 * nombre y email) y el PUT los quiere como ref cruda. Guardar el objeto poblado
 * tal cual rompe el cast a ObjectId del backend.
 */
function normalizeSuppliers(raw: unknown): Array<{ supplierId: string; providerCode: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const supplier = entry as { supplierId?: unknown; providerCode?: unknown }
      const ref = (supplier?.supplierId as { _id?: unknown })?._id ?? supplier?.supplierId
      if (ref === undefined || ref === null || ref === '') return null
      return {
        supplierId: String(ref),
        providerCode: typeof supplier?.providerCode === 'string' ? supplier.providerCode : '',
      }
    })
    .filter((s): s is { supplierId: string; providerCode: string } => s !== null)
}

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function createCatalogTools(httpClient: HttpClient) {
  const updateMaterialTool = tool(
    'update_material',
    'Modifica un articulo YA creado del catalogo de la empresa: nombre, codigo, unidad, descripcion, clasificacion, costo o modo de subcontratacion. ' +
      'Mandar SOLO los campos que cambian. Es la tool para corregir un articulo mal dado de alta — por ejemplo pasarlo a 100% subcontratado ' +
      '(subcontractMode "full") para que su costo salga del rubro Materiales y vaya al de Subcontratado. ' +
      'NO toca el stock (para eso esta update_warehouse_stock) y conserva los proveedores que el articulo ya tenia.',
    UpdateMaterialSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = UpdateMaterialSchema.parse(args)
        const { itemId, ...changes } = parsed

        if (Object.keys(changes).length === 0) {
          throw new Error('No se indico ningun campo a modificar.')
        }

        // Lectura previa: sin ella el PUT le borra los proveedores al articulo
        // (ver docstring del modulo) y no hay con que resolver el costoUnitario
        // que exige el modo "full".
        const current = (await httpClient.get(`/items/${itemId}`)) as StoredItem | null
        if (!current) {
          throw new Error(`No se encontro el articulo ${itemId} en el catalogo de la empresa.`)
        }

        const body: Record<string, unknown> = { ...changes }

        // El backend reemplaza `suppliers` por [] cuando el body no lo trae.
        body.suppliers = normalizeSuppliers(current.suppliers)

        // Modo "full" sin costo explicito: se reusa el del propio articulo antes
        // que dejar que el backend rechace la edicion con un 400. Nunca se
        // inventa un numero — sale del articulo y se informa en la respuesta.
        let costoUnitarioReusadoDe: 'costoUnitario' | 'defaultCost' | undefined
        if (changes.subcontractMode === 'full' && changes.costoUnitario === undefined) {
          if (isNonNegativeNumber(current.costoUnitario)) {
            body.costoUnitario = current.costoUnitario
            costoUnitarioReusadoDe = 'costoUnitario'
          } else if (isNonNegativeNumber(current.defaultCost)) {
            body.costoUnitario = current.defaultCost
            costoUnitarioReusadoDe = 'defaultCost'
          } else {
            throw new Error(
              `El articulo "${current.name ?? itemId}" no tiene un costo unitario cargado, y un articulo 100% subcontratado lo necesita. ` +
                'Volve a llamar update_material con costoUnitario.',
            )
          }
        }

        const updated = (await httpClient.request('PUT', `/items/${itemId}`, body)) as StoredItem

        const resultado = {
          id: String(updated?._id ?? itemId),
          name: updated?.name,
          code: updated?.code,
          unit: updated?.unit,
          defaultCost: updated?.defaultCost,
          subcontractMode: updated?.subcontractMode,
          subcontratado: updated?.subcontratado,
          costBreakdown: updated?.costBreakdown,
          proveedoresConservados: (body.suppliers as unknown[]).length,
          nota:
            costoUnitarioReusadoDe !== undefined
              ? `No se mando costoUnitario: se reuso el ${costoUnitarioReusadoDe} del articulo (${body.costoUnitario}). Verificalo con el usuario si no era el esperado.`
              : undefined,
        }

        const text = JSON.stringify(resultado, null, 2)
        logger.info(`update_material OK: ${itemId} → ${text.substring(0, 200)}`)
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`update_material FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  return [updateMaterialTool]
}
