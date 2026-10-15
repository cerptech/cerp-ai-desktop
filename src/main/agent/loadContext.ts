/**
 * loadContext — qué proyecto/presupuesto está cargando cada conversación (RQM-166).
 *
 * Los mcp tools van registrando acá los ids que ven pasar (args y respuestas de
 * create_project / create_budget / tools de presupuesto). Sirve para dos cosas:
 *  - el reintento de una carga cortada: el prompt de "Reintentar" nombra el
 *    proyecto y el presupuesto concretos, así una sesión nueva (que solo recibe el
 *    TEXTO de la conversación, no los resultados de las tools) retoma ESE borrador
 *    en vez de crear otro;
 *  - el aviso de "presupuesto listo", que necesita saber qué abrir y cómo se llama.
 *
 * Vive solo en memoria: si la app se reinicia, el reintento cae al genérico (el
 * agente busca el borrador con get_budget_by_project).
 */

export interface LoadContext {
  projectId?: string
  projectName?: string
  budgetId?: string
  /** quote_commit ya validó y cerró esta carga: un reintento no vuelve a reservar. */
  committed?: boolean
}

const contexts = new Map<string, LoadContext>()

function asId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) ? v : undefined
}

/** `_id` de la respuesta típica del core: `{ data: { _id } }`, `{ _id }` o `{ <key>: { _id } }`. */
function idFromResponse(data: unknown, key: string): string | undefined {
  const d = data as Record<string, any> | null | undefined
  return asId(d?.data?._id) ?? asId(d?._id) ?? asId(d?.[key]?._id) ?? asId(d?.data?.[key]?._id)
}

export function rememberLoadContext(conversationId: string, toolName: string, args: Record<string, unknown>, data: unknown): void {
  const prev = contexts.get(conversationId) ?? {}
  const next: LoadContext = { ...prev }

  if (toolName === 'create_project') {
    // Proyecto nuevo = carga nueva: lo que hubiera de una carga anterior ya no aplica.
    next.projectId = idFromResponse(data, 'project')
    next.projectName = typeof args.name === 'string' ? args.name : undefined
    next.budgetId = undefined
    next.committed = undefined
  } else if (toolName === 'create_budget') {
    next.budgetId = idFromResponse(data, 'budget') ?? next.budgetId
    next.committed = undefined
  } else if (toolName === 'quote_reserve') {
    next.committed = undefined
  } else if (toolName === 'quote_commit' && (data as { committed?: boolean } | null)?.committed) {
    next.committed = true
  }

  const projectId = asId(args.projectId)
  const budgetId = asId(args.budgetId)
  if (projectId) next.projectId = projectId
  if (budgetId) next.budgetId = budgetId

  if (next.projectId || next.budgetId) contexts.set(conversationId, next)
}

export function getLoadContext(conversationId: string): LoadContext | null {
  return contexts.get(conversationId) ?? null
}

export function clearLoadContext(conversationId: string): void {
  contexts.delete(conversationId)
}
