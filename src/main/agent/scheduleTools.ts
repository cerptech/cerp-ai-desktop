import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'
import type { AskUserQuestionItem } from '../ipc/types'

/**
 * Tools de CRONOGRAMA (planificador de obra) para el cliente desktop.
 *
 * # Por qué no son proxies REST como las de toolDefinitions.ts
 *
 * El desktop NO pega a `/api/planner/*`: consume las MISMAS tools que el canal
 * web/ERP (módulo `cerp-server/src/agents/schedule/`) a través de la ruta
 * `POST /api/ai-tools/:name` (plan "planificador-obra-2026-09", doc 03 §5.4,
 * opción B). Así el resolutor nombre → actividad, los resúmenes con tope de
 * tokens, la vista previa sellada con `planningRevision` y los permisos viven
 * en un solo lugar (el core) y el desktop no los duplica.
 *
 * Los esquemas Zod de acá son un ESPEJO escrito a mano del contrato del core
 * (mismo patrón que `BUDGET_HEADER_FIELD_IDS` en toolDefinitions.ts). Si el core
 * cambia un parámetro de una tool `schedule_*`, hay que llevarlo a este archivo.
 * El core vuelve a validar todo (400 con `{ error: { message, code } }`).
 *
 * # Contrato con el core
 *
 * - `POST /api/ai-tools/:name` con body `{ input }` → 200 `{ result: string }`
 *   (JSON string, el mismo que recibe el canal web). 400 input inválido, 403
 *   permiso/alcance/confirmación, 404 tool desconocida, 429 cuota diaria.
 * - `GET /api/ai-tools/schedule/previews/:previewId/card` →
 *   `{ titulo, campos: [{ label, value }], altoImpacto }` (404 si la vista
 *   previa no es del usuario o venció).
 *
 * # Sin companyId (ADR 007, regla 1)
 *
 * Estas tools NO pasan por la inyección automática de `companyId`/`user` que
 * mcpServer.ts hace sobre las `toolSchemas`: el body es solo `{ input }` y el
 * `input` sale del `parse` del esquema, que descarta cualquier clave que el
 * modelo agregue por su cuenta. El core ignora igual `companyId`/`user` en body
 * y query y toma la empresa del JWT, pero no se los mandamos para no alimentar
 * la idea de que el cliente elige el tenant.
 *
 * # Confirmación estructural (la primera del desktop)
 *
 * El agente corre con `permissionMode: 'bypassPermissions'` (agentManager.ts):
 * el SDK no le pide permiso a nadie antes de ejecutar una tool, y hasta ahora la
 * única confirmación posible era que el MODELO decidiera invocar
 * `ask_user_question`. Para el cronograma eso no alcanza (riesgo DESKTOP_NO_GATE,
 * doc 03 §12): mover una actividad puede correr decenas de fechas y el fin de obra.
 *
 * Por eso las tres tools del confirm set del core (`SCHEDULE_CONFIRM_TOOLS`:
 * `schedule_apply_change`, `schedule_update_annotation`, `schedule_set_settings`)
 * piden la confirmación DENTRO del handler, sin depender del modelo
 * (`confirmWithUser`):
 *   1. Arman la pregunta con datos que NO redacta el modelo. `schedule_apply_change`
 *      pide la tarjeta de la vista previa al core (`GET .../card`, redactada a
 *      partir del dry-run); las otras dos la arman acá con el input YA validado,
 *      que es exactamente lo que se va a mandar (id + cada campo que cambia).
 *   2. La muestran con `waitForAnswer` (askUserBridge.ts) y opciones
 *      "Aplicar" / "Cancelar", con aviso si es de alto impacto.
 *   3. Solo con "Aplicar" exacto hacen el POST, con `approved: true`: el mismo
 *      flag que pone cerp-ai-service tras la aprobación del usuario en web/ERP.
 *      Sin él, `runTool` responde a estas tools 403 `TOOL_NEEDS_CONFIRMATION`
 *      (el 403 "confirmación" del contrato de `/api/ai-tools`).
 *      Cancelar, "Otro: ..." o cualquier fallo al preguntar = NO hay POST y la
 *      tool devuelve `{ applied: false, reason }`.
 *   4. Si la tarjeta de una vista previa no se puede cargar (404, vencida, red),
 *      igual se pregunta, con un texto genérico que incluye el previewId: jamás
 *      se aplica sin preguntar.
 * Las altas (`schedule_capture_baseline`, `schedule_add_*`) van derecho, como en
 * el canal web ("crear va derecho; modificar, no") y nunca llevan `approved`.
 *
 * # Una vista previa por proyecto a la vez
 *
 * Cada vista previa queda sellada con la `planningRevision` del proyecto.
 * Aplicar CUALQUIER cambio sube esa revisión, así que las demás vistas previas
 * pendientes del mismo proyecto quedan `stale`. El prompt (y la descripción de
 * las tools) obliga a ir de a una: vista previa → aplicar/descartar → la
 * siguiente. Si no, el usuario confirma tarjetas que después fallan.
 */

// ── Tipos compartidos (espejo de srv/agents/schedule) ────────────────────────

const REF_DESCRIPTION =
  'Referencia "kind:refId" de la actividad (kind = task | construction_order | budget_item). ' +
  'Usa el ref EXACTO que devolvio schedule_find_activities (o un listado schedule_*), nunca un nombre ni un ref inventado.'

const NodeRef = z
  .string()
  .regex(/^(task|construction_order|budget_item):[a-f0-9]{24}$/, 'ref invalido: debe ser "kind:refId" (task|construction_order|budget_item + 24 hex)')
  .describe(REF_DESCRIPTION)

const TaskRef = z
  .string()
  .regex(/^task:[a-f0-9]{24}$/, 'debe ser un ref de tarea "task:<24 hex>"')
  .describe('Ref de una TAREA ("task:<id>"), exacto de schedule_find_activities.')

const OrderRef = z
  .string()
  .regex(/^construction_order:[a-f0-9]{24}$/, 'debe ser un ref de orden "construction_order:<24 hex>"')
  .describe('Ref de una ORDEN DE CONSTRUCCION ("construction_order:<id>"), exacto de schedule_find_activities.')

const ObjectId = z.string().regex(/^[a-f0-9]{24}$/, 'id invalido: 24 caracteres hexadecimales')

const ProjectId = ObjectId.describe('ID del proyecto (24 hex). Sale de get_company_projects / get_project_details.')

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha invalida: formato YYYY-MM-DD, sin hora')

const ActivityKind = z.enum(['task', 'construction_order', 'budget_item'])
const LinkType = z.enum(['FS', 'SS', 'FF', 'SF'])
const LagUnit = z.enum(['business', 'calendar'])
const ResourceStrategy = z.enum(['withinFloatOnly', 'allowExtension'])

const LinkBySelector = z.object({ linkId: ObjectId.describe('ID del vinculo (de schedule_get_activity).') })
const LinkByEndpoints = z.object({
  predecessor: NodeRef.describe('Ref de la predecesora. ' + REF_DESCRIPTION),
  successor: NodeRef.describe('Ref de la sucesora. ' + REF_DESCRIPTION),
})

// ── Esquemas: LECTURA ────────────────────────────────────────────────────────

const GetOverviewSchema = z.object({ projectId: ProjectId })

const FindActivitiesSchema = z.object({
  projectId: ProjectId,
  query: z.string().min(1).max(120).describe('Nombre o parte del nombre/codigo de la actividad tal como lo dijo el usuario.'),
  kind: ActivityKind.optional().describe('Restringe a un tipo: tarea, orden de construccion o partida del presupuesto.'),
  limit: z.number().int().min(1).max(15).optional().describe('Candidatos a devolver (default 8, max 15).'),
})

const ListActivitiesSchema = z.object({
  projectId: ProjectId,
  filter: z
    .object({
      critical: z.boolean().optional().describe('Solo actividades del camino critico.'),
      negativeFloat: z.boolean().optional().describe('Solo actividades con holgura negativa.'),
      late: z.boolean().optional().describe('Solo atrasadas (fin temprano anterior a hoy y no completadas).'),
      mode: z.enum(['manual', 'auto']).optional().describe('manual = fijadas; auto = las calcula el planificador.'),
      kind: ActivityKind.optional(),
      withinRef: NodeRef.optional().describe('Solo las que cuelgan de este contenedor (tarea padre, capitulo). ' + REF_DESCRIPTION),
      siteId: ObjectId.optional().describe('Solo las de esta obra (ID de obra).'),
      from: IsoDate.optional().describe('Ventana desde (YYYY-MM-DD).'),
      to: IsoDate.optional().describe('Ventana hasta (YYYY-MM-DD).'),
      search: z.string().max(120).optional().describe('Texto a buscar en el nombre.'),
    })
    .optional(),
  sort: z.enum(['earlyStart', 'earlyFinish', 'totalFloat']).optional().describe('Orden (default earlyStart).'),
  limit: z.number().int().min(1).max(50).optional().describe('Filas por pagina (default 25, max 50).'),
  offset: z.number().int().min(0).optional().describe('Desplazamiento para paginar.'),
})

const GetActivitySchema = z.object({ ref: NodeRef })

const ExplainCriticalitySchema = z.object({
  projectId: ProjectId,
  ref: NodeRef.optional().describe('Actividad a explicar. Sin ref: el camino critico dominante del proyecto. ' + REF_DESCRIPTION),
})

const GetLookaheadSchema = z.object({
  projectId: ProjectId,
  weeks: z.number().int().min(1).max(12).optional().describe('Semanas de la ventana (default 3).'),
  onlyBlocked: z.boolean().optional().describe('Solo actividades con restricciones abiertas que bloquean.'),
  limit: z.number().int().min(1).max(40).optional().describe('Max actividades (default 25, max 40).'),
})

const GetBaselineDeviationSchema = z.object({
  projectId: ProjectId,
  baselineId: ObjectId.optional().describe('Linea base a comparar (de schedule_list_baselines). Sin ella: la mas reciente.'),
  top: z.number().int().min(1).max(20).optional().describe('Cuantas actividades mas atrasadas listar (default 10, max 20).'),
})

const GetResourceConflictsSchema = z.object({
  projectId: ProjectId,
  strategy: ResourceStrategy.optional().describe('withinFloatOnly (default) = sin mover el fin de obra; allowExtension = permite alargarlo.'),
})

const ListAnnotationsSchema = z.object({
  projectId: ProjectId,
  type: z.enum(['milestones', 'constraints', 'both']).describe('Hitos, restricciones (Last Planner) o ambos.'),
  status: z.enum(['open', 'released', 'blocked']).optional().describe('Estado de la restriccion.'),
  limit: z.number().int().min(1).max(30).optional().describe('Max resultados (max 30).'),
})

const ListBaselinesSchema = z.object({ projectId: ProjectId })

// ── Esquemas: VISTA PREVIA (no escriben el cronograma) ───────────────────────

const PreviewDatesSchema = z.object({
  ref: NodeRef,
  startDate: IsoDate.optional().describe('Nuevo inicio (YYYY-MM-DD).'),
  endDate: IsoDate.optional().describe('Nuevo fin (YYYY-MM-DD).'),
  duration: z.number().int().min(0).max(3650).optional().describe('Nueva duracion (en durationUnit; dias = habiles).'),
  durationUnit: z.enum(['days', 'weeks', 'months']).optional(),
  mode: z.enum(['auto', 'manual']).optional().describe('manual = fijar la actividad en sus fechas; auto = liberarla para que la calcule el planificador.'),
})

const PreviewShiftSchema = z.object({
  refs: z.array(NodeRef).min(1).max(50).describe('Actividades a desplazar (max 50). ' + REF_DESCRIPTION),
  days: z.number().int().min(-260).max(260).describe('Dias a mover: positivo = atrasar, negativo = adelantar.'),
  unit: LagUnit.optional().describe('business (default) = dias habiles; calendar = dias corridos. "N dias" del usuario = habiles.'),
})

const PreviewConstraintSchema = z.object({
  ref: NodeRef,
  type: z
    .enum(['start_no_earlier_than', 'finish_no_later_than', 'none'])
    .describe('start_no_earlier_than = no empezar antes de; finish_no_later_than = terminar a mas tardar; none = quitar la restriccion.'),
  date: IsoDate.optional().describe('Fecha de la restriccion (YYYY-MM-DD). Obligatoria salvo type "none".'),
})

const PreviewLinksSchema = z.object({
  projectId: ProjectId,
  links: z
    .array(
      z.object({
        predecessor: NodeRef.describe('Ref de la predecesora. ' + REF_DESCRIPTION),
        successor: NodeRef.describe('Ref de la sucesora. ' + REF_DESCRIPTION),
        type: LinkType.optional().describe('FS (default) fin-inicio, SS inicio-inicio, FF fin-fin, SF inicio-fin.'),
        lag: z.number().int().optional().describe('Desfase: positivo = espera, negativo = solape (default 0).'),
        lagUnit: LagUnit.optional().describe('business (default) = dias habiles; calendar = corridos.'),
      }),
    )
    .min(1)
    .max(50)
    .describe('Vinculos a crear (max 50 por llamada; todo o nada).'),
  applyDates: z.boolean().optional().describe('Recalcular fechas con los vinculos nuevos (default true).'),
})

const PreviewUpdateLinkSchema = z.object({
  projectId: ProjectId,
  link: z.union([LinkBySelector, LinkByEndpoints]).describe('El vinculo a cambiar: { linkId } o { predecessor, successor }.'),
  type: LinkType.optional(),
  lag: z.number().int().optional(),
  lagUnit: LagUnit.optional(),
})

const PreviewUnlinkSchema = z.object({
  projectId: ProjectId,
  links: z
    .array(z.union([LinkBySelector, LinkByEndpoints.extend({ type: LinkType.optional() })]))
    .min(1)
    .max(20)
    .describe('Vinculos a quitar (max 20): { linkId } o { predecessor, successor, type? }.'),
})

const PreviewChainOrdersSchema = z.object({
  taskRef: TaskRef.describe('Tarea cuyas ordenes de construccion se encadenan en secuencia. Ref exacto de schedule_find_activities.'),
})

const PreviewRecalculateSchema = z.object({ projectId: ProjectId })

const PreviewResourceOptimizationSchema = z.object({
  projectId: ProjectId,
  strategy: ResourceStrategy.optional(),
  rule: z.string().max(60).optional().describe('Regla de prioridad de nivelacion (opcional; la del core por defecto).'),
  onlyRefs: z.array(NodeRef).max(50).optional().describe('Limitar la nivelacion a estas actividades (max 50).'),
})

const PreviewResourceQuantitySchema = z.object({
  orderRef: OrderRef.optional().describe('Forma 1: orden de construccion a la que se le fija la cantidad (con quantity).'),
  quantity: z.number().min(0).optional().describe('Forma 1: cantidad del recurso en la orden.'),
  taskRef: TaskRef.optional().describe('Forma 2: tarea cuyas ordenes se reparten el recurso (con totalUnits).'),
  totalUnits: z.number().min(0).optional().describe('Forma 2: unidades totales a repartir entre las ordenes de la tarea.'),
  resource: z.string().min(1).max(120).describe('Nombre o ID del recurso (mano de obra, maquinaria).'),
})

// ── Esquemas: APLICAR / ALTAS / MODIFICACIONES ───────────────────────────────

const ApplyChangeSchema = z.object({
  previewId: ObjectId.describe('previewId EXACTO devuelto por una schedule_preview_* de esta conversacion.'),
})

const CaptureBaselineSchema = z.object({
  projectId: ProjectId,
  name: z.string().min(1).max(80).describe('Nombre de la linea base (ej: "Contrato firmado").'),
})

const AddMilestoneSchema = z.object({
  projectId: ProjectId,
  name: z.string().min(1).max(120),
  date: IsoDate.describe('Fecha del hito (YYYY-MM-DD).'),
  isContractual: z.boolean().optional().describe('true si es un hito contractual (default false).'),
  ref: NodeRef.optional().describe('Actividad a la que se asocia el hito (opcional). ' + REF_DESCRIPTION),
})

const AddConstraintSchema = z.object({
  ref: NodeRef,
  category: z.enum(['material', 'permit', 'design', 'prerequisite', 'other']).describe('material, permiso, diseno/planos, prerrequisito u otro.'),
  description: z.string().min(1).max(300),
  responsible: z.string().max(120).optional().describe('Nombre del responsable (usuario de la empresa). Sin el: el usuario actual.'),
  dueDate: IsoDate.optional().describe('Fecha limite para liberar la restriccion (YYYY-MM-DD).'),
  isBlocking: z.boolean().optional().describe('Si bloquea el inicio de la actividad (default true).'),
})

const UpdateAnnotationSchema = z.object({
  kind: z.enum(['milestone', 'constraint']),
  id: ObjectId.describe('ID del hito o restriccion (de schedule_list_annotations).'),
  status: z.enum(['open', 'released', 'blocked']).optional().describe('Solo restricciones. "released" = liberada.'),
  date: IsoDate.optional().describe('Solo hitos: nueva fecha.'),
  dueDate: IsoDate.optional().describe('Solo restricciones: nueva fecha limite.'),
  isBlocking: z.boolean().optional().describe('Solo restricciones.'),
  name: z.string().min(1).max(120).optional().describe('Solo hitos.'),
  description: z.string().min(1).max(300).optional().describe('Solo restricciones.'),
})

/** Campos que el core acepta por tipo de anotación (fuera de estos responde 400). */
const ANNOTATION_FIELDS = {
  milestone: ['name', 'date'],
  constraint: ['status', 'dueDate', 'isBlocking', 'description'],
} as const

const SetSettingsSchema = z.object({
  projectId: ProjectId,
  schedulingInput: z.enum(['duration', 'dates']).optional().describe('Como se carga el cronograma: por duracion o por fechas.'),
  durationUnit: z.enum(['days', 'weeks', 'months']).optional().describe('Unidad de duracion por defecto.'),
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true }
}

/**
 * Error legible para el modelo a partir de un fallo de la API. Usa el
 * `{ error: { message, code } }` del core; nunca el stack ni el body crudo.
 */
function describeHttpError(err: unknown): { error: string; code?: string; status?: number } {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string; code?: string } | string; message?: string } | undefined
    const apiMessage = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message
    const code = typeof body?.error === 'object' ? body.error?.code : undefined
    const fallback: Record<number, string> = {
      400: 'Datos invalidos para esta tool.',
      403: 'Sin permiso para esta accion en el cronograma.',
      404: 'Tool o recurso no encontrado en el servidor de CERP.',
      429: 'Se alcanzo la cuota diaria de acciones de CERP IA.',
    }
    return {
      error: apiMessage || fallback[err.status] || `Error del servidor de CERP (HTTP ${err.status}).`,
      ...(code ? { code } : {}),
      status: err.status,
    }
  }
  return { error: err instanceof Error ? err.message : String(err) }
}

/** Errores de validación Zod en una línea por campo, sin stack. */
function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; ')
}

/**
 * POST /ai-tools/:name con `{ input }` (sin companyId) → el `result` (JSON string) del core.
 * `approved: true` SOLO lo pasa un handler después de que el usuario pulsó
 * "Aplicar" en `confirmWithUser`; el resto de las tools nunca lo manda.
 */
async function callCoreTool(
  httpClient: HttpClient,
  name: string,
  input: Record<string, unknown>,
  { approved = false }: { approved?: boolean } = {},
): Promise<string> {
  const body = approved ? { input, approved: true } : { input }
  const res = await httpClient.post<{ result?: unknown }>(`/ai-tools/${encodeURIComponent(name)}`, body)
  const result = res?.result
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

interface ScheduleToolSpec {
  name: string
  description: string
  schema: z.ZodObject
  /** Tools que no escriben el cronograma: el SDK las puede correr en paralelo. */
  readOnly: boolean
  /** Chequeo cruzado entre campos que el esquema plano no expresa. Devuelve el error o null. */
  check?: (input: Record<string, unknown>) => string | null
  /**
   * Tools que MODIFICAN algo existente sin pasar por una vista previa (confirm
   * set del core): arma, con el input ya validado, la pregunta que el handler le
   * hace al usuario antes del POST. Sin "Aplicar" no hay POST.
   */
  confirm?: (input: Record<string, unknown>) => AskUserQuestionItem
}

function hasAny(input: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => input[k] !== undefined)
}

// ── Confirmación estructural (waitForAnswer) ─────────────────────────────────

/** Lo que se le muestra al usuario: la tarjeta del core o una armada con el input validado. */
interface ConfirmCard {
  titulo: string
  campos: Array<{ label: string; value: string }>
  altoImpacto: boolean
}

const APPLY_OPTION = 'Aplicar'
const CANCEL_OPTION = 'Cancelar'
const MAX_QUESTION_CHARS = 1500

function cardText(card: ConfirmCard, pregunta: string): string {
  const campos = card.campos.map((c) => `${c.label}: ${c.value}`).join(' · ')
  const aviso = card.altoImpacto ? 'CAMBIO DE ALTO IMPACTO. ' : ''
  return `${aviso}${card.titulo}${campos ? ` — ${campos}` : ''}. ${pregunta}`
}

/** Pregunta "Aplicar" / "Cancelar". `header` es el chip de la UI (max 12 caracteres). */
function confirmQuestion(question: string, header: string, applyDescription: string): AskUserQuestionItem {
  return {
    question: question.length > MAX_QUESTION_CHARS ? `${question.slice(0, MAX_QUESTION_CHARS - 1)}…` : question,
    header,
    multiSelect: false,
    options: [
      { label: APPLY_OPTION, description: applyDescription },
      { label: CANCEL_OPTION, description: 'No se modifica nada.' },
    ],
  }
}

type ConfirmOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: 'cancelled_by_user' | 'not_confirmed'; mensaje: string }

/**
 * Le pregunta al usuario en SU conversación y espera la respuesta. Solo
 * "Aplicar" exacto confirma: cancelar, "Otro: ...", una respuesta vacía o
 * cualquier fallo al preguntar (sin ventana, sesión cancelada, otra pregunta
 * que la reemplaza) = no confirmado. Nunca lanza.
 */
async function confirmWithUser(conversationId: string, question: AskUserQuestionItem, logTag: string): Promise<ConfirmOutcome> {
  let answer: string
  try {
    const answers = await waitForAnswer(conversationId, { questions: [question] })
    const raw = answers[question.question] ?? Object.values(answers)[0]
    answer = (Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`${logTag}: sin confirmacion (${message}) — no se aplica`)
    return {
      confirmed: false,
      reason: 'not_confirmed',
      mensaje: `No se pudo pedir la confirmacion al usuario (${message}). El cambio NO se aplico.`,
    }
  }

  if (answer === APPLY_OPTION) return { confirmed: true }

  const otro = answer.startsWith('Otro:') ? answer.slice('Otro:'.length).trim() : ''
  logger.info(`${logTag}: el usuario no confirmo (${answer || 'sin respuesta'})`)
  return {
    confirmed: false,
    reason: 'cancelled_by_user',
    mensaje: otro
      ? `El usuario no aplico el cambio y respondio: "${otro}". No se modifico nada en el cronograma.`
      : 'El usuario cancelo el cambio. No se modifico nada en el cronograma; no lo reintentes sin que lo pida.',
  }
}

/** Resultado de la tool cuando no hubo confirmación: `{ applied: false, reason }`, sin POST. */
function unconfirmedResult(outcome: Extract<ConfirmOutcome, { confirmed: false }>) {
  return outcome.reason === 'not_confirmed'
    ? errorResult({ applied: false, reason: outcome.reason, error: outcome.mensaje })
    : textResult(JSON.stringify({ applied: false, reason: outcome.reason, mensaje: outcome.mensaje }))
}

const CONSTRAINT_STATUS_LABEL: Record<'open' | 'released' | 'blocked', string> = {
  open: 'abierta',
  released: 'liberada',
  blocked: 'bloqueada',
}
const SCHEDULING_INPUT_LABEL: Record<'duration' | 'dates', string> = { duration: 'por duracion', dates: 'por fechas' }
const DURATION_UNIT_LABEL: Record<'days' | 'weeks' | 'months', string> = { days: 'dias', weeks: 'semanas', months: 'meses' }

/** Confirmación de `schedule_update_annotation`: el id y cada campo que cambia, tal cual se envía. */
function annotationQuestion(input: z.infer<typeof UpdateAnnotationSchema>): AskUserQuestionItem {
  const campos: ConfirmCard['campos'] = []
  if (input.name !== undefined) campos.push({ label: 'Nombre', value: `"${input.name}"` })
  if (input.date !== undefined) campos.push({ label: 'Fecha', value: input.date })
  if (input.status !== undefined) campos.push({ label: 'Estado', value: CONSTRAINT_STATUS_LABEL[input.status] })
  if (input.dueDate !== undefined) campos.push({ label: 'Fecha limite', value: input.dueDate })
  if (input.isBlocking !== undefined) campos.push({ label: 'Bloquea el inicio', value: input.isBlocking ? 'si' : 'no' })
  if (input.description !== undefined) campos.push({ label: 'Descripcion', value: `"${input.description}"` })

  const milestone = input.kind === 'milestone'
  const titulo = milestone
    ? `Modificar el hito ${input.id}`
    : input.status === 'released'
      ? `Liberar la restriccion ${input.id}`
      : `Modificar la restriccion ${input.id}`
  return confirmQuestion(
    cardText({ titulo, campos, altoImpacto: false }, '¿Aplicar este cambio al cronograma?'),
    milestone ? 'Hito' : 'Restriccion',
    milestone ? 'Guarda el cambio del hito en CERP.' : 'Guarda el cambio de la restriccion en CERP.',
  )
}

/** Confirmación de `schedule_set_settings`: el proyecto y cada ajuste que cambia. */
function settingsQuestion(input: z.infer<typeof SetSettingsSchema>): AskUserQuestionItem {
  const campos: ConfirmCard['campos'] = []
  if (input.schedulingInput !== undefined) {
    campos.push({ label: 'Planificar', value: SCHEDULING_INPUT_LABEL[input.schedulingInput] })
  }
  if (input.durationUnit !== undefined) {
    campos.push({ label: 'Unidad de duracion por defecto', value: DURATION_UNIT_LABEL[input.durationUnit] })
  }
  return confirmQuestion(
    cardText(
      { titulo: `Cambiar los ajustes del planificador del proyecto ${input.projectId}`, campos, altoImpacto: false },
      'No mueve fechas. ¿Aplicar este cambio?',
    ),
    'Planificador',
    'Guarda los ajustes del planificador del proyecto en CERP.',
  )
}

// ── Definiciones ─────────────────────────────────────────────────────────────

const WRITE_REF_RULE = 'Usa el ref exacto de schedule_find_activities, nunca un nombre.'
const PREVIEW_RULE =
  'NO escribe nada: devuelve previewId, resumenParaUsuario, impacto y tarjeta. Contale al usuario el impacto con esos datos y, si quiere seguir, llama a schedule_apply_change con el previewId (el sistema le pide confirmacion al usuario). ' +
  'De a UNA vista previa por proyecto: aplicala (o descartala) antes de preparar la siguiente; aplicar cualquier cambio deja vencidas (stale) las demas vistas previas pendientes del mismo proyecto. Nunca prepares varias en paralelo para aplicarlas despues. ' +
  WRITE_REF_RULE
const CONFIRM_RULE =
  'Antes de escribir, el sistema le muestra al usuario el cambio y le pide "Aplicar" o "Cancelar": no le preguntes vos antes. ' +
  'Si cancela (applied:false, reason "cancelled_by_user"), no reintentes sin que lo pida.'

const SCHEDULE_TOOLS: ScheduleToolSpec[] = [
  // ── Lectura ────────────────────────────────────────────────────────────────
  {
    name: 'schedule_get_overview',
    description:
      'Resumen del cronograma de un proyecto: inicio y fin previsto, plazo minimo, caminos criticos, actividades criticas/fijadas/atrasadas/con holgura negativa, errores, restricciones bloqueantes, proximos hitos y desvio contra la ultima linea base. ' +
      'Usar primero ante "¿como esta el cronograma?" o antes de proponer cambios.',
    schema: GetOverviewSchema,
    readOnly: true,
  },
  {
    name: 'schedule_find_activities',
    description:
      'Resuelve un nombre dicho por el usuario a actividades del cronograma (tareas, ordenes de construccion o partidas) y devuelve candidatos con su ref "kind:refId". ' +
      'Usar SIEMPRE antes de cualquier tool que reciba un ref. Si hay mas de un candidato plausible, preguntale al usuario cual es; nunca elijas a ciegas.',
    schema: FindActivitiesSchema,
    readOnly: true,
  },
  {
    name: 'schedule_list_activities',
    description:
      'Lista actividades del cronograma con filtros (criticas, holgura negativa, atrasadas, fijadas/automaticas, tipo, dentro de un contenedor, obra, ventana de fechas, texto) y orden. Paginado (max 50 filas). ' +
      'Usar para "¿que esta atrasado?", "¿que es critico este mes?" o para obtener refs de un grupo de actividades.',
    schema: ListActivitiesSchema,
    readOnly: true,
  },
  {
    name: 'schedule_get_activity',
    description:
      'Ficha completa de una actividad: fechas tempranas/tardias, holguras (dias habiles), modo, duracion, restriccion, predecesoras y sucesoras con tipo y lag (con linkId), estado, avance, restricciones Last Planner, hitos y motivoCriticidad. ' +
      'Usar para detallar una actividad o antes de cambiar sus vinculos.',
    schema: GetActivitySchema,
    readOnly: true,
  },
  {
    name: 'schedule_explain_criticality',
    description:
      'Explica por que una actividad es critica o que la retrasa: la cadena de predecesoras que la empujan hasta el ancla (inicio de proyecto, fecha fijada o restriccion). Sin ref: el camino critico dominante. ' +
      'Usar ante "¿por que es critica?", "¿que la retrasa?", "¿cual es el camino critico?". Explica con estos datos y con motivoCriticidad, sin reglas propias.',
    schema: ExplainCriticalitySchema,
    readOnly: true,
  },
  {
    name: 'schedule_get_lookahead',
    description:
      'Lookahead (Last Planner): actividades de las proximas N semanas con sus restricciones y responsables, mas el PPC por semana. ' +
      'Usar para planificacion semanal, "¿que arranca en las proximas semanas?" o "¿que esta bloqueado?".',
    schema: GetLookaheadSchema,
    readOnly: true,
  },
  {
    name: 'schedule_get_baseline_deviation',
    description:
      'Desvio del cronograma actual contra una linea base: delta del fin de obra, conteo de actividades adelantadas/atrasadas y las mas atrasadas con nombre. ' +
      'Usar ante "¿cuanto nos atrasamos respecto del plan?". Las lineas base se listan con schedule_list_baselines.',
    schema: GetBaselineDeviationSchema,
    readOnly: true,
  },
  {
    name: 'schedule_get_resource_conflicts',
    description:
      'Sobreasignacion de recursos (mano de obra, maquinaria) en el cronograma y la mejor propuesta de nivelacion (movimientos, semanas resueltas, extension del plazo). Solo lectura. ' +
      'Para preparar esa nivelacion como cambio, usar schedule_preview_resource_optimization.',
    schema: GetResourceConflictsSchema,
    readOnly: true,
  },
  {
    name: 'schedule_list_annotations',
    description: 'Lista hitos y/o restricciones (Last Planner) del cronograma de un proyecto, con su estado, fechas y responsables. Devuelve los IDs para schedule_update_annotation.',
    schema: ListAnnotationsSchema,
    readOnly: true,
  },
  {
    name: 'schedule_list_baselines',
    description: 'Lista las lineas base capturadas del cronograma de un proyecto (id, nombre, fecha de captura).',
    schema: ListBaselinesSchema,
    readOnly: true,
  },

  // ── Vista previa ───────────────────────────────────────────────────────────
  {
    name: 'schedule_preview_dates',
    description:
      'Prepara un cambio de fechas, duracion o modo de UNA actividad: nuevo inicio/fin, nueva duracion, fijarla (mode "manual") o liberarla (mode "auto"). ' +
      'Usar para "mové X al 15/03", "la instalacion dura 3 semanas", "fijá/liberá X". Los contenedores (tareas padre, capitulos) no se fechan: se mueven sus hijas. ' +
      PREVIEW_RULE,
    schema: PreviewDatesSchema,
    readOnly: true,
    check: (i) =>
      hasAny(i, ['startDate', 'endDate', 'duration', 'durationUnit', 'mode'])
        ? null
        : 'Indica al menos un cambio: startDate, endDate, duration, durationUnit o mode.',
  },
  {
    name: 'schedule_preview_shift',
    description:
      'Prepara el desplazamiento de una o varias actividades N dias (positivo = atrasar, negativo = adelantar). El servidor calcula las fechas con el calendario de cada actividad. ' +
      '"N dias" del usuario = dias habiles (unit "business") salvo que diga corridos. ' +
      PREVIEW_RULE,
    schema: PreviewShiftSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_constraint',
    description:
      'Prepara una restriccion de fecha sobre una actividad: "no empezar antes de" (start_no_earlier_than), "terminar a mas tardar" (finish_no_later_than) o quitarla (none). ' +
      PREVIEW_RULE,
    schema: PreviewConstraintSchema,
    readOnly: true,
    check: (i) => (i.type !== 'none' && i.date === undefined ? 'date es obligatoria salvo con type "none".' : null),
  },
  {
    name: 'schedule_preview_links',
    description:
      'Prepara la creacion de vinculos de precedencia entre actividades (FS/SS/FF/SF con lag), todo o nada, max 50 por llamada. ' +
      'Usar al cargar las predecesoras de un Gantt/MS Project (despues de crear las tareas) o ante "X empieza cuando termina Y". Para mas de 50 vinculos, hacer varios lotes (vista previa + aplicar cada uno). ' +
      PREVIEW_RULE,
    schema: PreviewLinksSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_update_link',
    description:
      'Prepara el cambio de tipo o lag de UN vinculo existente, identificado por linkId (de schedule_get_activity) o por predecesora + sucesora. ' +
      PREVIEW_RULE,
    schema: PreviewUpdateLinkSchema,
    readOnly: true,
    check: (i) => (hasAny(i, ['type', 'lag', 'lagUnit']) ? null : 'Indica al menos un cambio: type, lag o lagUnit.'),
  },
  {
    name: 'schedule_preview_unlink',
    description:
      'Prepara la eliminacion de vinculos de precedencia (max 20), por linkId o por predecesora + sucesora. Siempre es un cambio de alto impacto. ' +
      PREVIEW_RULE,
    schema: PreviewUnlinkSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_chain_orders',
    description:
      'Prepara el encadenamiento en secuencia (FS) de las ordenes de construccion de una tarea, en su orden actual. ' +
      PREVIEW_RULE,
    schema: PreviewChainOrdersSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_recalculate',
    description:
      'Prepara un recalculo completo del cronograma (reprograma las actividades automaticas segun vinculos, restricciones y calendarios). Usar si el overview marca fechas desactualizadas o el usuario lo pide. ' +
      PREVIEW_RULE,
    schema: PreviewRecalculateSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_resource_optimization',
    description:
      'Prepara la nivelacion de recursos sobreasignados (mueve actividades dentro de su holgura o, con allowExtension, alargando el plazo). Revisar antes con schedule_get_resource_conflicts. ' +
      PREVIEW_RULE,
    schema: PreviewResourceOptimizationSchema,
    readOnly: true,
  },
  {
    name: 'schedule_preview_resource_quantity',
    description:
      'Prepara el cambio de cantidad de un recurso: en UNA orden de construccion (orderRef + quantity) o repartido entre las ordenes de una tarea (taskRef + totalUnits). Cambia duraciones y puede mover fechas. ' +
      PREVIEW_RULE,
    schema: PreviewResourceQuantitySchema,
    readOnly: true,
    check: (i) => {
      const byOrder = i.orderRef !== undefined || i.quantity !== undefined
      const byTask = i.taskRef !== undefined || i.totalUnits !== undefined
      if (byOrder && byTask) return 'Usa una sola forma: { orderRef, resource, quantity } o { taskRef, resource, totalUnits }.'
      if (byOrder && (i.orderRef === undefined || i.quantity === undefined)) return 'La forma por orden requiere orderRef y quantity.'
      if (byTask && (i.taskRef === undefined || i.totalUnits === undefined)) return 'La forma por tarea requiere taskRef y totalUnits.'
      if (!byOrder && !byTask) return 'Indica { orderRef, resource, quantity } o { taskRef, resource, totalUnits }.'
      return null
    },
  },

  // ── Altas (van derecho, como en el canal web) ──────────────────────────────
  {
    name: 'schedule_capture_baseline',
    description:
      'Captura una linea base del cronograma actual (foto para comparar desvios despues). Usar cuando el usuario lo pide, tipicamente al firmar contrato o al arrancar la obra.',
    schema: CaptureBaselineSchema,
    readOnly: false,
  },
  {
    name: 'schedule_add_milestone',
    description: 'Crea un hito en el cronograma (fecha clave, contractual o no), opcionalmente asociado a una actividad. ' + WRITE_REF_RULE,
    schema: AddMilestoneSchema,
    readOnly: false,
  },
  {
    name: 'schedule_add_constraint',
    description:
      'Crea una restriccion Last Planner sobre una actividad (falta material, permiso, planos, prerrequisito) con responsable y fecha limite. No mueve fechas. ' + WRITE_REF_RULE,
    schema: AddConstraintSchema,
    readOnly: false,
  },

  // ── Modificaciones (confirm set: el handler pregunta antes del POST) ───────
  {
    name: 'schedule_update_annotation',
    description:
      'Modifica un hito (nombre, fecha) o una restriccion existente (estado, fecha limite, si bloquea, descripcion); p. ej. liberar una restriccion (status "released"). El id sale de schedule_list_annotations. ' +
      CONFIRM_RULE,
    schema: UpdateAnnotationSchema,
    readOnly: false,
    // Mismo rechazo que el core, pero ANTES de pedirle confirmación al usuario.
    check: (i) => {
      const own: readonly string[] = i.kind === 'milestone' ? ANNOTATION_FIELDS.milestone : ANNOTATION_FIELDS.constraint
      const other: readonly string[] = i.kind === 'milestone' ? ANNOTATION_FIELDS.constraint : ANNOTATION_FIELDS.milestone
      const invalid = other.filter((f) => i[f] !== undefined)
      if (invalid.length > 0) {
        return i.kind === 'milestone'
          ? `Un hito no tiene ${invalid.join(', ')} (solo name y date).`
          : `Una restriccion no tiene ${invalid.join(', ')} (usa dueDate / description).`
      }
      return hasAny(i, [...own]) ? null : 'Indica al menos un campo a modificar.'
    },
    confirm: (i) => annotationQuestion(i as z.infer<typeof UpdateAnnotationSchema>),
  },
  {
    name: 'schedule_set_settings',
    description:
      'Cambia los ajustes del planificador del proyecto: si el cronograma se carga por duracion o por fechas y la unidad de duracion por defecto. No mueve fechas. ' +
      CONFIRM_RULE,
    schema: SetSettingsSchema,
    readOnly: false,
    check: (i) => (hasAny(i, ['schedulingInput', 'durationUnit']) ? null : 'Indica schedulingInput y/o durationUnit.'),
    confirm: (i) => settingsQuestion(i as z.infer<typeof SetSettingsSchema>),
  },
]

// ── schedule_apply_change: confirmación con la tarjeta del core ──────────────

/** Tarjeta de la vista previa redactada por el core; null si no está (404, vencida, red). */
async function fetchPreviewCard(httpClient: HttpClient, previewId: string): Promise<ConfirmCard | null> {
  try {
    const raw = await httpClient.get<Partial<ConfirmCard> | null>(
      `/ai-tools/schedule/previews/${encodeURIComponent(previewId)}/card`,
    )
    if (!raw || typeof raw.titulo !== 'string') return null
    return {
      titulo: raw.titulo,
      campos: Array.isArray(raw.campos)
        ? raw.campos
            .filter((c): c is { label: string; value: string } => !!c && typeof c === 'object')
            .map((c) => ({ label: String(c.label ?? ''), value: String(c.value ?? '') }))
        : [],
      altoImpacto: raw.altoImpacto === true,
    }
  } catch (err) {
    const { error, status } = describeHttpError(err)
    logger.warn(`schedule_apply_change: no se pudo cargar la tarjeta de ${previewId} (${status ?? 'sin status'}): ${error}`)
    return null
  }
}

function applyQuestion(previewId: string, card: ConfirmCard | null): AskUserQuestionItem {
  const question = card
    ? cardText(card, '¿Aplicar este cambio al cronograma?')
    : `¿Aplicar al cronograma el cambio preparado en la vista previa ${previewId}? ` +
      'No se pudo cargar su resumen: revisa el detalle que te mostro CERP IA en el chat antes de confirmar.'
  const highImpact = card?.altoImpacto === true
  return confirmQuestion(
    question,
    highImpact ? 'Alto impacto' : 'Cronograma',
    highImpact
      ? 'Guarda el cambio en el cronograma de CERP. Es de alto impacto: revisa los datos antes de aplicarlo.'
      : 'Guarda el cambio en el cronograma de CERP.',
  )
}

function createApplyChangeTool(httpClient: HttpClient, conversationId: string) {
  return tool(
    'schedule_apply_change',
    'Aplica al cronograma un cambio preparado con una schedule_preview_*. Es la UNICA tool que modifica fechas y vinculos del cronograma. ' +
      'Antes de ejecutar, el sistema le muestra al usuario la tarjeta de la vista previa y le pide "Aplicar" o "Cancelar": no hace falta que le preguntes vos otra vez. ' +
      'Aplicar deja vencidas (stale) las demas vistas previas pendientes del mismo proyecto: prepara la siguiente recien despues de aplicar esta. ' +
      'Si responde applied:false con reason "stale" (el cronograma cambio) o "expired" (vencio a los 15 min), prepara una vista previa nueva. Si el usuario cancela, no reintentes sin que lo pida.',
    ApplyChangeSchema as any,
    async (args: Record<string, unknown>) => {
      const parsed = ApplyChangeSchema.safeParse(args)
      if (!parsed.success) return errorResult({ error: describeZodError(parsed.error) })
      const { previewId } = parsed.data

      const card = await fetchPreviewCard(httpClient, previewId)
      const outcome = await confirmWithUser(conversationId, applyQuestion(previewId, card), `schedule_apply_change[${previewId}]`)
      if (!outcome.confirmed) return unconfirmedResult(outcome)

      try {
        const result = await callCoreTool(httpClient, 'schedule_apply_change', { previewId }, { approved: true })
        logger.info(`schedule_apply_change[${previewId}] OK: ${result.substring(0, 200)}`)
        return textResult(result)
      } catch (err) {
        const described = describeHttpError(err)
        logger.error(`schedule_apply_change[${previewId}] FAILED: ${described.error}`)
        return errorResult(described)
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: true } },
  )
}

/**
 * Tools `schedule_*` del servidor MCP `cerp` (mismos nombres que en el core, así
 * `mcp__cerp__*` las cubre). `conversationId` es el de la conversación que corre
 * el agente: las confirmaciones (`schedule_apply_change`,
 * `schedule_update_annotation`, `schedule_set_settings`) se muestran en esa.
 */
export function createScheduleTools(httpClient: HttpClient, conversationId: string) {
  const proxied = SCHEDULE_TOOLS.map((spec) =>
    tool(
      spec.name,
      spec.description,
      spec.schema as any,
      async (args: Record<string, unknown>) => {
        const parsed = spec.schema.safeParse(args)
        if (!parsed.success) return errorResult({ error: describeZodError(parsed.error) })
        const input = parsed.data as Record<string, unknown>
        const invalid = spec.check?.(input)
        if (invalid) return errorResult({ error: invalid })

        // Modificaciones sin vista previa: se confirman acá, antes del POST.
        let approved = false
        if (spec.confirm) {
          const outcome = await confirmWithUser(conversationId, spec.confirm(input), spec.name)
          if (!outcome.confirmed) return unconfirmedResult(outcome)
          approved = true
        }

        try {
          const result = await callCoreTool(httpClient, spec.name, input, { approved })
          logger.info(`MCP ${spec.name} OK: ${result.substring(0, 200)}`)
          return textResult(result)
        } catch (err) {
          const described = describeHttpError(err)
          logger.error(`MCP ${spec.name} FAILED: ${described.error}`)
          return errorResult(described)
        }
      },
      // Modificar algo existente es "destructivo" en el sentido MCP (no solo agrega).
      { annotations: { readOnlyHint: spec.readOnly, destructiveHint: spec.confirm !== undefined } },
    ),
  )

  return [...proxied, createApplyChangeTool(httpClient, conversationId)]
}
