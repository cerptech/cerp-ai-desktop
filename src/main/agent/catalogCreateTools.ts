import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Altas del catálogo para CERP IA Desktop: `create_item` (materiales e ítems, con
 * su composición) y `create_resource` (mano de obra y maquinaria/herramientas).
 *
 * Son las MISMAS tools que usan web, ERP y WhatsApp (tarjeta «CERP IA: permitir
 * crear materiales sin ser admin», ADR 017: CERP IA es una): la lógica vive en el
 * core (`cerp-server/src/agents/shared/catalogCreateTools.ts`) y el Desktop las
 * ejecuta por `POST /api/ai-tools/:name` con `{ input }`, igual que el cronograma
 * y los documentos de proyecto. El core comprueba el permiso para el canal
 * `desktop` (`materials:create` / `resources:create`, fail-closed), la empresa de
 * la sesión y la cuota diaria, y aplica las reglas del formulario del ERP:
 *
 *  - código obligatorio y único (lo propone la IA si la persona no lo da);
 *  - a un ítem se le elige SIEMPRE la subcontratación; «Sí, completo» exige el
 *    costo unitario y no lleva composición;
 *  - la composición (materiales y recursos por unidad) es opcional y puede traer
 *    materiales/recursos NUEVOS: se crea todo en un paso o no se crea nada;
 *  - queda quién lo pidió y que fue «desde CERP IA Desktop».
 *
 * Reemplazan a las tools propias del Desktop (`create_material`, la
 * `create_item` de `catalogTools.ts` y la `create_resource` declarativa), que
 * tenían reglas distintas a los otros canales.
 *
 * Los esquemas Zod de acá son un ESPEJO a mano del contrato del core: si el
 * core cambia un parámetro, hay que traerlo a este archivo. Sin `companyId` ni
 * `user` (ADR 007): el core los toma del JWT.
 */

const ObjectId = z.string().regex(/^[a-f0-9]{24}$/, 'id invalido: 24 caracteres hexadecimales')
const SubcontractMode = z.enum(['none', 'labor_only', 'full'])
const ResourceType = z.enum(['labor', 'tools_machinery'])
const CostRateType = z.enum(['hourly', 'daily', 'fixed', 'unit', 'm2', 'm3'])

const NewMaterialSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).describe('Codigo propuesto siguiendo el formato de la empresa.'),
  unit: z.string().optional(),
  defaultCost: z.number().min(0).optional().describe('Costo de referencia del material (opcional).'),
})

const NewResourceSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).describe('Codigo propuesto siguiendo el formato de la empresa.'),
  type: ResourceType,
  costRate: z.number().min(0).describe('Tarifa: preguntasela a la persona, nunca la inventes.'),
  costRateType: CostRateType.optional().describe('Por defecto "hourly".'),
  hoursPerDay: z.number().min(0.5).max(24).optional().describe('Solo con tarifa diaria. Por defecto 8.'),
})

const MaterialLineSchema = z.object({
  materialId: ObjectId.optional().describe('Id de un material que ya existe (search_materials). O esto o newMaterial.'),
  newMaterial: NewMaterialSchema.optional().describe('Material que todavia no existe: se da de alta en el mismo paso.'),
  quantityNeeded: z.number().positive().describe('Cuanto de ese material consume una unidad del item (ej. 15 ladrillos por m2).'),
  unitCost: z.number().min(0).optional().describe('Precio para esta receta. Si no viene, el del catalogo (lo habitual).'),
})

const ResourceLineSchema = z.object({
  resourceId: ObjectId.optional().describe('Id de un recurso que ya existe (search_resources). O esto o newResource.'),
  newResource: NewResourceSchema.optional().describe('Recurso que todavia no existe: se da de alta en el mismo paso (hace falta Recursos > Crear).'),
  quantity: z.number().positive().optional().describe('Cuantas unidades del recurso trabajan a la vez (ej. 2 oficiales). Default 1. NO son las horas.'),
  hoursPerUnit: z.number().min(0).optional().describe('Horas (o dias, si la tarifa es diaria) por unidad del item.'),
})

const CreateItemSchema = z.object({
  name: z.string().min(1).describe('Nombre del articulo.'),
  nature: z.enum(['material', 'item']).describe('"material" (insumo que se compra y se consume) o "item" (partida, producto o servicio).'),
  code: z.string().min(1).describe('Codigo unico en la empresa: el que dio la persona o el que propusiste siguiendo el formato de la empresa.'),
  unit: z.string().optional().describe('Unidad de medida (m2, ml, ud, kg, bolsa...).'),
  description: z.string().optional(),
  defaultCost: z.number().min(0).optional().describe('Costo unitario de referencia.'),
  currentStock: z.number().optional().describe('Stock inicial (materiales). Por defecto 0.'),
  minimumStock: z.number().optional(),
  subcontractMode: SubcontractMode.optional().describe(
    'OBLIGATORIO para un item, la opcion que eligio la persona: "none" = No; "labor_only" = Si. Mano de obra, herramientas y maquinaria; "full" = Si, completo. Un material no lleva.',
  ),
  costoUnitario: z.number().min(0).optional().describe('Costo unitario del servicio subcontratado. OBLIGATORIO con "full".'),
  materialsRequired: z.array(MaterialLineSchema).optional().describe('Composicion: materiales por unidad del item. Opcional; no con "full".'),
  resourcesRequired: z.array(ResourceLineSchema).optional().describe('Composicion: mano de obra y maquinaria por unidad del item. Opcional; no con "full".'),
})

const CreateResourceSchema = z.object({
  name: z.string().min(1).describe('Nombre del recurso.'),
  type: ResourceType.describe('"labor" = mano de obra; "tools_machinery" = herramientas y maquinaria.'),
  code: z.string().min(1).describe('Codigo unico en la empresa: el que dio la persona o el que propusiste siguiendo el formato de la empresa.'),
  costRate: z.number().min(0).describe('Tarifa. OBLIGATORIA: preguntasela a la persona, nunca la inventes.'),
  costRateType: CostRateType.optional().describe('Como se cobra la tarifa. Por defecto "hourly".'),
  hoursPerDay: z.number().min(0.5).max(24).optional().describe('Solo con tarifa diaria. Por defecto 8.'),
  description: z.string().optional(),
  canBeSubcontracted: z.boolean().optional().describe('Casilla "Se puede subcontratar". Por defecto false.'),
  supplierContactId: ObjectId.optional().describe('Contratista que ejecuta el recurso (search_contacts). Solo con canBeSubcontracted: true.'),
})

const CREATE_ITEM_DESCRIPTION =
  'Da de alta un articulo del catalogo de la empresa, con las mismas reglas que el formulario del ERP y que CERP IA en la web y WhatsApp. ' +
  'Antes buscalo con search_materials para no duplicarlo. ' +
  'nature: "material" es un insumo que se compra, entra al almacen y se consume (cemento, chapa, tornillos); "item" es una partida, un trabajo que se presupuesta y se ejecuta, o un servicio subcontratado. Si no esta claro, preguntaselo a la persona. ' +
  'La mano de obra y la maquinaria NO son articulos: son recursos (create_resource). ' +
  'El codigo es obligatorio y unico. Si la persona no da uno, no se lo pidas: proponelo vos siguiendo el formato que ya usa la empresa (mira los codigos de search_materials) y decíselo al confirmar. ' +
  'Para un ITEM, preguntale SIEMPRE a la persona la subcontratacion (ask_user_question), con las tres opciones y lo que implica cada una — no la elijas vos: ' +
  '"No" (item propio; su costo es el de referencia o el de su composicion), ' +
  '"Si. Mano de obra, herramientas y maquinaria" (materiales propios; la mano de obra y el equipo los pone un subcontratista, con recursos subcontratables) y ' +
  '"Si, completo" (todo el item es un servicio subcontratado: el costo unitario pasa a ser obligatorio y no lleva composicion). ' +
  'COMPOSICION (items "No" y "Si. Mano de obra..."): opcional, ofrecesela. Busca todas las lineas juntas (search_materials, search_resources), junta las dudas en una sola pregunta, ' +
  'y para lo que no existe manda newMaterial / newResource (codigo propuesto; para un recurso, la tarifa que diga la persona): se crea todo en un solo paso o no se crea nada. ' +
  'Antes de llamar, confirma con la persona en un solo mensaje el item y toda su composicion, marcando lo nuevo.'

const CREATE_RESOURCE_DESCRIPTION =
  'Da de alta un recurso de MANO DE OBRA (oficial, peon, cuadrilla) o de MAQUINARIA/HERRAMIENTA (excavadora, compactadora, hormigonera), con las mismas reglas que el formulario del ERP. ' +
  'Antes buscalo con search_resources para no duplicarlo. ' +
  'El codigo es obligatorio y unico: si la persona no da uno, proponelo vos siguiendo el formato de la empresa. La tarifa (costRate) es obligatoria: preguntasela, nunca la inventes. ' +
  'Si el recurso lo pone un subcontratista, canBeSubcontracted: true (y supplierContactId si nombra a quien). ' +
  'Si el recurso es para la composicion de un item que estas creando, NO uses esta tool: va como newResource dentro de create_item.'

/** El mensaje de un error HTTP del core (permiso, cuota…) como resultado de la tool. */
function describeHttpError(err: unknown): string {
  if (err instanceof HttpError) {
    const data = err.body as { error?: { message?: string }; message?: string } | undefined
    const apiMessage = data?.error?.message ?? data?.message
    const fallback: Record<number, string> = {
      403: 'No tenes permiso para esta alta en CERP. Pedile a un administrador de tu empresa que te lo habilite.',
      429: 'Se alcanzo la cuota diaria de acciones de CERP IA.',
    }
    return `Error: ${apiMessage || fallback[err.status] || `error del servidor de CERP (HTTP ${err.status})`}`
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`
}

/** POST /ai-tools/:name con `{ input }` (sin companyId) → el `result` (texto) del core. */
async function callCoreTool(httpClient: HttpClient, name: string, input: Record<string, unknown>): Promise<string> {
  const res = await httpClient.post<{ result?: unknown }>(`/ai-tools/${encodeURIComponent(name)}`, { input })
  const result = res?.result
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

function coreTool(httpClient: HttpClient, name: string, description: string, schema: z.ZodObject<z.ZodRawShape>) {
  return tool(name, description, schema as any, async (args: Record<string, unknown>) => {
    try {
      const input = schema.parse(args) as Record<string, unknown>
      const text = await callCoreTool(httpClient, name, input)
      logger.info(`${name}: ${text.substring(0, 200)}`)
      return { content: [{ type: 'text' as const, text }], ...(text.startsWith('Error') ? { isError: true } : {}) }
    } catch (err) {
      const text = err instanceof z.ZodError ? `Error: parametros invalidos — ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : describeHttpError(err)
      logger.error(`${name} FAILED: ${text}`)
      return { content: [{ type: 'text' as const, text }], isError: true }
    }
  })
}

export function createCatalogCreateTools(httpClient: HttpClient) {
  return [
    coreTool(httpClient, 'create_item', CREATE_ITEM_DESCRIPTION, CreateItemSchema),
    coreTool(httpClient, 'create_resource', CREATE_RESOURCE_DESCRIPTION, CreateResourceSchema),
  ]
}

/** Para el test de contrato: los campos que el Desktop manda al core. */
export const CATALOG_CREATE_SCHEMAS = { create_item: CreateItemSchema, create_resource: CreateResourceSchema }
