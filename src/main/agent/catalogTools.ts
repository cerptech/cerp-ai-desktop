import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tools de ESCRITURA del CATÁLOGO que no entran en el proxy REST declarativo de
 * `toolDefinitions.ts`.
 *
 * # Material vs ítem: dos cosas distintas, un solo endpoint
 *
 * En CERP son dos pantallas y dos formularios separados (`/materials/create` y
 * `/items/create` en la web), pero los dos escriben sobre `POST /items`. Lo que
 * los separa es el campo `nature`:
 *
 * - **material** (`nature: 'material'`) — un insumo suelto: cemento, chapa,
 *   tornillos. Tiene stock, proveedores y listas de precios; NO tiene
 *   composición. Se crea con `create_item` (nature 'material'), que vive en el core:
 *   `catalogCreateTools.ts`.
 * - **ítem / producto** (`nature: 'item'`) — una partida. Tiene un modo de
 *   subcontratación OBLIGATORIO (`subcontractMode`) y, salvo que sea 100%
 *   subcontratada, una composición: materiales + recursos (el APU). Se crea
 *   con `create_item`, acá.
 *
 * Si `nature` no viaja explícito, el backend lo DERIVA (`itemNatureCategory.ts`:
 * hay BOM o la classification es `product_type` → 'item'). Por eso las dos tools
 * lo mandan fijo: la clasificación de un ítem no puede quedar librada a qué
 * campos se acordó de mandar el modelo.
 *
 * # Por qué `create_item` no es declarativa
 *
 * El backend guarda la composición ya resuelta: cada línea de material necesita
 * su `unitCost` (sin él aporta 0 al costo y queda un ítem "caja vacía") y cada
 * línea de recurso necesita `resourceName`, `costRate`, `costRateType` y
 * `estimatedCost` —campos que el modelo no tiene a mano, y `resourceName` es
 * `required` en el schema—. Esta tool los resuelve contra el catálogo, igual que
 * el formulario de la web tiene el catálogo cargado en pantalla.
 *
 * # Por qué `update_catalog_item` tampoco
 *
 * `PUT /items/:id` es un update parcial salvo por un detalle: el controller hace
 * `if (!Array.isArray(body.suppliers)) body.suppliers = []`. O sea, CUALQUIER
 * edición que no reenvíe los proveedores se los borra al artículo, en silencio.
 * Un proxy declarativo no puede evitarlo: no sabe qué proveedores tenía antes.
 */

// ── create_item ──────────────────────────────────────────────────────────────

const MaterialLineSchema = z.object({
  materialId: z.string().min(1).describe('ID del material del catalogo (search_materials). NUNCA inventarlo.'),
  quantityNeeded: z.number().positive().describe('Cuanto de este material se consume por 1 unidad del item (ej: 0,35 m3 de hormigon por m2 de losa).'),
  unitCost: z
    .number()
    .min(0)
    .optional()
    .describe('Precio unitario para esta receta. Si se omite se usa el costo del material en el catalogo (lo habitual).'),
})

const ResourceLineSchema = z.object({
  resourceId: z.string().min(1).describe('ID del recurso del catalogo (search_resources). NUNCA inventarlo.'),
  quantity: z
    .number()
    .positive()
    .optional()
    .describe('Cuantas UNIDADES del recurso trabajan en paralelo (ej: 2 oficiales a la vez). Default 1. NO son las horas.'),
  hoursPerUnit: z
    .number()
    .min(0)
    .optional()
    .describe('Horas (o dias, si el recurso se tarifa por dia) planificadas por 1 unidad del item. ACA van las horas.'),
  estimatedCost: z
    .number()
    .min(0)
    .optional()
    .describe('Costo del recurso en este item. Si se omite se calcula con la tarifa del catalogo (lo recomendado).'),
})

const CreateItemSchema = z.object({
  name: z.string().min(1).describe('Nombre de la partida.'),
  code: z.string().min(1).describe('Codigo unico en la empresa. OBLIGATORIO: el backend rechaza el alta sin codigo.'),
  unit: z.string().optional().describe('Unidad de medida de la partida (m2, ml, ud, kg...).'),
  description: z.string().optional().describe('Descripcion tecnica. Se hereda al presupuesto cada vez que se usa la partida.'),
  classification: z.string().optional().describe('ID de la clasificacion (get_classifications, tipo "product_type").'),
  category: z.string().optional().describe('ID de una categoria del catalogo (ObjectId). NO es texto libre.'),
  subcontractMode: z
    .enum(['none', 'labor_only', 'full'])
    .describe(
      'OBLIGATORIO, es lo que define el tipo de item. ' +
        '"none": la hace la empresa — lleva composicion de materiales y/o recursos. ' +
        '"labor_only": la mano de obra la pone un tercero — lleva materiales propios + recursos subcontratables. ' +
        '"full": 100% subcontratada, se compra hecha — NO lleva composicion, solo costoUnitario.',
    ),
  costoUnitario: z
    .number()
    .min(0)
    .optional()
    .describe('Precio cerrado del subcontrato por unidad. OBLIGATORIO con subcontractMode "full"; no se usa en los otros modos.'),
  materialsRequired: z.array(MaterialLineSchema).optional().describe('Materiales que consume 1 unidad de la partida.'),
  resourcesRequired: z.array(ResourceLineSchema).optional().describe('Mano de obra y maquinaria que consume 1 unidad de la partida.'),
})

const UpdateCatalogItemSchema = z.object({
  itemId: z.string().min(1).describe('ID del material o item a modificar (el _id que devuelve search_materials).'),
  name: z.string().optional(),
  code: z.string().optional().describe('Codigo unico en la empresa.'),
  unit: z.string().optional(),
  description: z.string().optional(),
  classification: z.string().optional().describe('ID de la clasificacion (get_classifications, tipo "product_type").'),
  nature: z
    .enum(['material', 'item'])
    .optional()
    .describe('Reclasifica la entrada: "material" (insumo) o "item" (partida). Usar solo si se dio de alta en el lado equivocado.'),
  defaultCost: z.number().optional().describe('Costo unitario de referencia.'),
  subcontractMode: z
    .enum(['none', 'labor_only', 'full'])
    .optional()
    .describe(
      '"full" = 100% subcontratado: todo el costo se imputa al rubro Subcontratado. Requiere costoUnitario; si no se manda se reusa el que ya tenga la entrada (o su costo unitario actual).',
    ),
  costoUnitario: z.number().min(0).optional().describe('Costo unitario del servicio subcontratado.'),
  minimumStock: z.number().min(0).optional().describe('Bajo este nivel el material figura como stock bajo.'),
})

interface StoredItem {
  _id?: string
  name?: string
  code?: string
  unit?: string
  nature?: string
  defaultCost?: number
  costoUnitario?: number
  subcontractMode?: string
  subcontratado?: boolean
  suppliers?: unknown
  costBreakdown?: Record<string, number>
}

interface StoredResource {
  _id?: string
  name?: string
  costRate?: number
  costRateType?: string
  hoursPerDay?: number
  canBeSubcontracted?: boolean
  type?: string
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

/**
 * Costo de una línea de recurso, con la MISMA fórmula que el formulario de la
 * web (`ProductForm.tsx`, transform de `resourceAssignments`):
 *
 *   hourly → tarifa × horas × unidades en paralelo
 *   daily  → tarifa × días × unidades
 *   fixed  → la tarifa ES el total de la línea: no se multiplica por nada
 *   resto  → tarifa × unidades
 *
 * Si el modelo mandó `estimatedCost` explícito, gana el suyo: puede estar
 * copiando el importe de un presupuesto del proveedor.
 */
function computeResourceCost(
  line: { quantity?: number; hoursPerUnit?: number; estimatedCost?: number },
  resource: StoredResource,
): number {
  if (isNonNegativeNumber(line.estimatedCost)) return line.estimatedCost
  const rate = isNonNegativeNumber(resource.costRate) ? resource.costRate : 0
  const qty = line.quantity ?? 1
  const hours = line.hoursPerUnit ?? 0
  let total: number
  switch (resource.costRateType) {
    case 'fixed':
      total = rate
      break
    case 'hourly':
    case 'daily':
      total = rate * hours * qty
      break
    default:
      total = rate * qty
  }
  // A centimos: es plata y queda guardada en el catalogo. Sin esto, 28 x 0,8
  // entra como 22.400000000000002 y ese epsilon se arrastra a todo presupuesto
  // que use la partida.
  return Math.round((total + Number.EPSILON) * 100) / 100
}

export function createCatalogTools(httpClient: HttpClient) {
  const updateCatalogItemTool = tool(
    'update_catalog_item',
    'Modifica un MATERIAL o una PARTIDA ya creados del catalogo: nombre, codigo, unidad, descripcion, clasificacion, costo o modo de subcontratacion. ' +
      'Mandar SOLO los campos que cambian. Es la tool para corregir un alta mal hecha — por ejemplo pasar una partida a 100% subcontratada ' +
      '(subcontractMode "full") para que su costo salga del rubro Materiales y vaya al de Subcontratado, o reclasificar con `nature` algo que se dio de alta del lado equivocado. ' +
      'NO edita la composicion de una partida ni toca el stock, y conserva los proveedores que la entrada ya tenia.',
    UpdateCatalogItemSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = UpdateCatalogItemSchema.parse(args)
        const { itemId, ...changes } = parsed

        if (Object.keys(changes).length === 0) {
          throw new Error('No se indico ningun campo a modificar.')
        }

        // Lectura previa: sin ella el PUT le borra los proveedores a la entrada
        // (ver docstring del modulo) y no hay con que resolver el costoUnitario
        // que exige el modo "full".
        const current = (await httpClient.get(`/items/${itemId}`)) as StoredItem | null
        if (!current) {
          throw new Error(`No se encontro la entrada ${itemId} en el catalogo de la empresa.`)
        }

        const body: Record<string, unknown> = { ...changes }

        // El backend reemplaza `suppliers` por [] cuando el body no lo trae.
        body.suppliers = normalizeSuppliers(current.suppliers)

        // Modo "full" sin costo explicito: se reusa el de la propia entrada antes
        // que dejar que el backend rechace la edicion con un 400. Nunca se
        // inventa un numero — sale de la entrada y se informa en la respuesta.
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
              `"${current.name ?? itemId}" no tiene un costo unitario cargado, y una partida 100% subcontratada lo necesita. ` +
                'Volve a llamar update_catalog_item con costoUnitario.',
            )
          }
        }

        const updated = (await httpClient.request('PUT', `/items/${itemId}`, body)) as StoredItem

        const resultado = {
          id: String(updated?._id ?? itemId),
          name: updated?.name,
          code: updated?.code,
          unit: updated?.unit,
          nature: updated?.nature,
          defaultCost: updated?.defaultCost,
          subcontractMode: updated?.subcontractMode,
          subcontratado: updated?.subcontratado,
          costBreakdown: updated?.costBreakdown,
          proveedoresConservados: (body.suppliers as unknown[]).length,
          nota:
            costoUnitarioReusadoDe !== undefined
              ? `No se mando costoUnitario: se reuso el ${costoUnitarioReusadoDe} de la entrada (${body.costoUnitario}). Verificalo con el usuario si no era el esperado.`
              : undefined,
        }

        const text = JSON.stringify(resultado, null, 2)
        logger.info(`update_catalog_item OK: ${itemId} → ${text.substring(0, 200)}`)
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`update_catalog_item FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // create_item vive en el core (catalogCreateTools.ts): la misma de web, ERP y WhatsApp.
  return [updateCatalogItemTool]
}
