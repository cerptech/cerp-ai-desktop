/**
 * turnOutcome — cómo termina un turno del agente cuando NO termina bien (RQM-166).
 *
 * Antes, cualquier `result` del SDK (incluidos `error_max_turns`,
 * `error_max_budget_usd` y `error_during_execution`) se mapeaba a un `done` mudo: la
 * UI dejaba de girar y el usuario no sabía si la carga había terminado, había fallado
 * o seguía corriendo. Acá se clasifica cada final con error en un código estable +
 * un mensaje accionable, y se arma el prompt de "Reintentar" que retoma la carga.
 *
 * Funciones puras: sin Electron ni estado, para poder probarlas aisladas.
 */
import type { LoadContext } from './loadContext'

export type TurnFailureCode =
  | 'TURN_TIMEOUT'
  | 'MAX_TURNS'
  | 'MAX_BUDGET'
  | 'PROMPT_TOO_LONG'
  | 'API_ERROR'
  | 'EXECUTION_ERROR'
  | 'PROCESS_ERROR'

export interface TurnFailure {
  code: TurnFailureCode
  /** Texto para el chat: qué pasó, de quién es el problema y qué hacer. */
  message: string
  /** Versión corta para la notificación del sistema. */
  short: string
}

/** Lo que devuelve el SDK en un `result` (SDKResultSuccess | SDKResultError), solo lo que usamos. */
export interface SdkResultLike {
  subtype?: string
  is_error?: boolean
  terminal_reason?: string
  errors?: string[]
  result?: string
}

/** null = el turno terminó bien; 'ABORTED' = se interrumpió (Detener, cambio de empresa o el watchdog). */
export function classifyResult(msg: SdkResultLike): TurnFailureCode | 'ABORTED' | null {
  const { subtype, is_error: isError, terminal_reason: reason } = msg
  if (subtype === 'success' && !isError) return null
  if (reason === 'aborted_streaming' || reason === 'aborted_tools') return 'ABORTED'
  if (subtype === 'error_max_turns' || reason === 'max_turns') return 'MAX_TURNS'
  if (subtype === 'error_max_budget_usd') return 'MAX_BUDGET'
  if (reason === 'prompt_too_long') return 'PROMPT_TOO_LONG'
  if (reason === 'model_error' || (subtype === 'success' && isError)) return 'API_ERROR'
  return 'EXECUTION_ERROR'
}

/** Detalle crudo para el log (nunca para el usuario). */
export function resultErrorDetail(msg: SdkResultLike): string {
  const parts = [msg.subtype, msg.terminal_reason, ...(msg.errors ?? []), msg.is_error ? msg.result : undefined]
  return parts.filter(Boolean).join(' | ').slice(0, 1000)
}

const KEPT_LOAD = 'Lo que ya se cargó en CERP quedó guardado como borrador: pulsa «Reintentar» y CERP IA continúa donde quedó, sin volver a adjuntar los archivos.'
const KEPT_GENERIC = 'Pulsa «Reintentar» para que CERP IA continúe donde quedó.'
const NOT_YOUR_DATA = 'Es un problema del sistema, no de tus datos.'

/** `inLoad` = había una carga de presupuesto en curso (reserva abierta o proyecto/presupuesto tocado). */
export function describeTurnFailure(code: TurnFailureCode, inLoad: boolean, timeoutMinutes = 15): TurnFailure {
  const kept = inLoad ? KEPT_LOAD : KEPT_GENERIC
  const what = inLoad ? 'La carga del presupuesto se detuvo' : 'CERP IA se detuvo'
  switch (code) {
    case 'TURN_TIMEOUT':
      return {
        code,
        message: `${what}: CERP IA no dio señales de actividad durante ${timeoutMinutes} minutos y se cortó la ejecución. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what}: no respondió durante ${timeoutMinutes} minutos.`,
      }
    case 'MAX_TURNS':
      return {
        code,
        message: `${what} porque llegó al máximo de pasos permitidos en una sola ejecución. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what}: llegó al máximo de pasos de una ejecución.`,
      }
    case 'MAX_BUDGET':
      return {
        code,
        message: `${what} porque alcanzó el límite de consumo de una ejecución. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what}: alcanzó el límite de consumo de una ejecución.`,
      }
    case 'PROMPT_TOO_LONG':
      return {
        code,
        message: `${what} porque la conversación se volvió demasiado larga para seguir en la misma ejecución. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what}: la conversación es demasiado larga.`,
      }
    case 'API_ERROR':
      return {
        code,
        message: `${what} porque el servicio de IA no respondió (sobrecarga o corte de conexión). ${NOT_YOUR_DATA} ${kept} Si vuelve a pasar, espera unos minutos.`,
        short: `${what}: el servicio de IA no respondió.`,
      }
    case 'PROCESS_ERROR':
      return {
        code,
        message: `${what} porque el proceso de CERP IA se cerró inesperadamente. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what}: el proceso se cerró inesperadamente.`,
      }
    case 'EXECUTION_ERROR':
    default:
      return {
        code,
        message: `${what} por un error interno de CERP IA. ${NOT_YOUR_DATA} ${kept}`,
        short: `${what} por un error interno.`,
      }
  }
}

/**
 * Prompt que manda "Reintentar". Tras un fallo la sesión del SDK se cierra, así que el
 * reintento arranca una sesión NUEVA que solo recibe el texto de la conversación (no
 * los resultados de las tools): por eso se nombran los ids concretos del borrador.
 */
export function buildRetryPrompt(ctx: LoadContext | null): string {
  if (ctx && (ctx.projectId || ctx.budgetId)) {
    const ids = [
      ctx.projectName ? `proyecto «${ctx.projectName}»` : null,
      ctx.projectId ? `projectId ${ctx.projectId}` : null,
      ctx.budgetId ? `budgetId ${ctx.budgetId}` : null,
    ].filter(Boolean).join(', ')
    if (ctx.committed) {
      return (
        'Reintentar: la ejecución anterior se cortó antes de terminar. ' +
        `El presupuesto (${ids}) ya está validado y cerrado con quote_commit: NO vuelvas a reservar ni a crear nada en CERP. ` +
        'Continúa solo con lo que faltaba después del cierre (por ejemplo, los entregables Excel/PDF y quote_register_files).'
      )
    }
    return (
      'Reintentar: la ejecución anterior se cortó antes de terminar. ' +
      `Retoma la carga donde quedó: el presupuesto parcial está guardado en CERP como borrador (${ids}). ` +
      'Revisa qué capítulos y partidas ya existen y completa solo lo que falta, sin crear otro proyecto ni otro presupuesto y sin duplicar capítulos. ' +
      'La reserva de la cotización anterior se liberó: vuelve a llamar a quote_eligibility y quote_reserve antes de seguir, y al terminar recalcula y cierra con quote_commit.'
    )
  }
  return (
    'Reintentar: la ejecución anterior se cortó antes de terminar. ' +
    'Continúa con la última tarea que te pedí a partir de lo que ya hiciste. ' +
    'Si estabas cargando un presupuesto, búscalo con get_budget_by_project y retómalo en vez de crear uno nuevo.'
  )
}
