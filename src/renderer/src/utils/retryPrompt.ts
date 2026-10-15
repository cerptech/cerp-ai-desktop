import type { ChatMessage } from '../hooks/useAgent'

/**
 * Reintento de una ejecución cortada (RQM-166).
 *
 * El main manda el prompt de reintento junto con el error (con los ids del borrador si
 * los conoce — ver turnOutcome.ts). Cuando el corte lo detecta el propio renderer (el
 * main dejó de latir) no hay prompt del main y se usa este genérico.
 */
export const GENERIC_RETRY_PROMPT =
  'Reintentar: la ejecución anterior se cortó antes de terminar. ' +
  'Continúa con la última tarea que te pedí a partir de lo que ya hiciste. ' +
  'Si estabas cargando un presupuesto, búscalo con get_budget_by_project y retómalo en vez de crear uno nuevo.'

/** Reintento tras una validación fallida del entregable (cotización con datos incompletos). */
export function dataRetryPrompt(failures: string[]): string {
  const what = failures.length ? ` Lo que faltó: ${failures.join('; ')}.` : ''
  return (
    'Completa la carga del presupuesto que no pasó la validación, sobre el MISMO borrador (sin crear otro proyecto ni otro presupuesto).' +
    what +
    ' Si no se puede completar con los archivos que tienes, dime exactamente qué datos faltan. ' +
    'Cuando esté completo, vuelve a llamar a quote_eligibility y quote_reserve, recalcula y cierra con quote_commit.'
  )
}

const ATTACHMENT_LINE = /^\[Archivo adjunto: .+\]$/gm

/**
 * Suma al prompt de reintento las rutas de los archivos que el usuario ya había
 * adjuntado en la conversación: el reintento no obliga a volver a cargarlos, y la
 * sesión nueva los tiene aunque el historial que recibe trunque los mensajes largos.
 */
export function withAttachments(prompt: string, messages: ChatMessage[]): string {
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const line of m.content.match(ATTACHMENT_LINE) ?? []) seen.add(line)
  }
  return seen.size ? `${prompt}\n\nArchivos de esta carga (ya están en tu equipo, no hace falta volver a adjuntarlos):\n${[...seen].join('\n')}` : prompt
}
