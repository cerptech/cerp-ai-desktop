import type { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Heartbeat del cortafuegos de cotización (Idea 2).
 *
 * Mientras hay una reserva de crédito activa (entre quote_reserve y quote_commit),
 * latimos periódicamente al backend (`POST /quotes/:id/heartbeat`). Si el proceso se
 * cuelga o el usuario cierra la app sin terminar, los latidos se detienen y el
 * watchdog del backend refunda la reserva por timeout. Así un crédito nunca queda
 * "consumido" por una tarea que murió a mitad de camino.
 */

const HEARTBEAT_INTERVAL_MS = 10_000

let timer: NodeJS.Timeout | null = null
let activeQuoteId: string | null = null

/** Arranca (o reemplaza) el heartbeat para una reserva recién creada. */
export function startQuoteHeartbeat(quoteId: string, httpClient: HttpClient): void {
  stopQuoteHeartbeat()
  activeQuoteId = quoteId
  logger.info(`Quote heartbeat iniciado para reserva ${quoteId}`)
  timer = setInterval(() => {
    if (!activeQuoteId) return
    httpClient.post(`/quotes/${activeQuoteId}/heartbeat`, {}).catch((err) => {
      // 409 (reserva ya no activa) o error de red: no es fatal — el watchdog cubre el caso.
      logger.warn(`Quote heartbeat falló para ${activeQuoteId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, HEARTBEAT_INTERVAL_MS)
}

/** Detiene el heartbeat (commit, refund, abort o cierre de sesión). */
export function stopQuoteHeartbeat(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (activeQuoteId) {
    logger.info(`Quote heartbeat detenido para reserva ${activeQuoteId}`)
    activeQuoteId = null
  }
}

/** quoteId de la reserva activa, o null si no hay ninguna. */
export function getActiveReservationId(): string | null {
  return activeQuoteId
}

/**
 * Igual que {@link getActiveReservationId} pero con `undefined` en vez de `null` —
 * conveniente para spread en bodies de request donde `undefined` se omite en el JSON
 * (usageReporter la usa para adjuntar el quoteId de la cotización en curso, si hay una).
 */
export function getActiveQuoteId(): string | undefined {
  return activeQuoteId ?? undefined
}
