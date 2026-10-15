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
 *
 * Una reserva POR CONVERSACIÓN (RQM-166): antes había un solo timer global, así que
 * la reserva de una segunda conversación reemplazaba a la primera (que dejaba de latir
 * y el watchdog la refundaba a mitad de la carga), y cerrar cualquier sesión detenía
 * el latido de todas.
 */

const HEARTBEAT_INTERVAL_MS = 10_000

interface ActiveReservation {
  quoteId: string
  timer: NodeJS.Timeout
}

const reservations = new Map<string, ActiveReservation>()

/** Arranca (o reemplaza) el heartbeat de la reserva recién creada en esta conversación. */
export function startQuoteHeartbeat(conversationId: string, quoteId: string, httpClient: HttpClient): void {
  stopQuoteHeartbeat(conversationId)
  logger.info(`Quote heartbeat iniciado para reserva ${quoteId} (${conversationId})`)
  const timer = setInterval(() => {
    httpClient.post(`/quotes/${quoteId}/heartbeat`, {}).catch((err) => {
      // 409 (reserva ya no activa) o error de red: no es fatal — el watchdog cubre el caso.
      logger.warn(`Quote heartbeat falló para ${quoteId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, HEARTBEAT_INTERVAL_MS)
  reservations.set(conversationId, { quoteId, timer })
}

/** Detiene el heartbeat de esta conversación (commit, refund, abort o cierre de sesión). */
export function stopQuoteHeartbeat(conversationId: string): void {
  const r = reservations.get(conversationId)
  if (!r) return
  clearInterval(r.timer)
  reservations.delete(conversationId)
  logger.info(`Quote heartbeat detenido para reserva ${r.quoteId} (${conversationId})`)
}

/** Detiene todos los heartbeats (logout / reset global). */
export function stopAllQuoteHeartbeats(): void {
  for (const id of [...reservations.keys()]) stopQuoteHeartbeat(id)
}

/** quoteId de la reserva activa de esta conversación, o null si no hay ninguna. */
export function getActiveReservationId(conversationId: string): string | null {
  return reservations.get(conversationId)?.quoteId ?? null
}

/**
 * Igual que {@link getActiveReservationId} pero con `undefined` en vez de `null` —
 * conveniente para spread en bodies de request donde `undefined` se omite en el JSON
 * (usageReporter la usa para adjuntar el quoteId de la cotización en curso, si hay una).
 */
export function getActiveQuoteId(conversationId: string): string | undefined {
  return getActiveReservationId(conversationId) ?? undefined
}
