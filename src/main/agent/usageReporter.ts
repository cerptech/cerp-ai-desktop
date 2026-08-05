import { randomUUID } from 'crypto'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { getActiveQuoteId } from './quoteHeartbeat'

/**
 * Reporta el consumo de tokens por ejecución al backend (rentabilidad por cliente,
 * débito de créditos — Modelo CERP).
 *
 * agentManager captura el uso en cada mensaje `result` del SDK y lo reenvía acá.
 * El POST a /usage es fire-and-forget: un fallo al reportar nunca debe cortar ni
 * demorar el stream del agente. La empresa/usuario los resuelve el backend desde
 * el token autenticado (no se envían en el body), así un cliente no puede imputar
 * consumo a otro.
 *
 * Cada reporte lleva una `idempotencyKey` propia (el backend debita créditos de
 * forma idempotente por esa key) y se reintenta con backoff (1s/5s/25s) ante fallos
 * de red conservando SIEMPRE la misma key — así un reintento nunca duplica el débito.
 * Agotados los reintentos, se descarta y se loguea (pérdida asumida). Una cola
 * persistida en disco para sobrevivir a un cierre de la app queda para otra fase:
 *
 * // TODO(fase futura): persistir reportes pendientes en disco (p.ej. electron-store)
 * // y reintentarlos al arrancar la app, en vez de perderlos si se agotan los reintentos
 * // en memoria o la app se cierra a mitad de la cola de reintentos.
 */

const RETRY_DELAYS_MS = [1_000, 5_000, 25_000]

let httpClientRef: HttpClient | null = null
let sessionModel = 'unknown'
let sessionContextId: string | null = null

export interface ExecutionUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd?: number
  turns?: number
  turbo?: boolean
}

/** Fija el cliente HTTP, el modelo efectivo y el contexto de la sesión activa. */
export function initUsageReporter(httpClient: HttpClient, model: string, contextId: string | null = null): void {
  httpClientRef = httpClient
  sessionModel = model || 'unknown'
  sessionContextId = contextId
}

/** Persiste el consumo de una ejecución. No lanza: loguea y sigue. Nunca bloquea. */
export function reportExecutionUsage(usage: ExecutionUsage): void {
  const httpClient = httpClientRef
  if (!httpClient) return

  const idempotencyKey = randomUUID()
  const body = {
    model: sessionModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.costUsd ?? 0,
    turns: usage.turns ?? 0,
    turbo: usage.turbo ?? false,
    contextId: sessionContextId ?? undefined,
    kind: 'desktop_agent',
    quoteId: getActiveQuoteId(),
    idempotencyKey,
  }

  sendWithRetry(httpClient, body, idempotencyKey, 0)
}

/**
 * Envía el reporte reintentando con backoff ante fallo. Misma `idempotencyKey` en
 * todos los intentos — el backend debita créditos una sola vez por esa key aunque
 * el POST se reintente. Fire-and-forget en cada paso: nunca hay un `await` que
 * bloquee al caller.
 */
function sendWithRetry(httpClient: HttpClient, body: Record<string, unknown>, idempotencyKey: string, attempt: number): void {
  httpClient.post('/usage', body).catch((err) => {
    if (attempt < RETRY_DELAYS_MS.length) {
      const delayMs = RETRY_DELAYS_MS[attempt]
      logger.warn(`[usage] reporte falló (intento ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}, key=${idempotencyKey}): ${err}. Reintentando en ${delayMs}ms`)
      setTimeout(() => sendWithRetry(httpClient, body, idempotencyKey, attempt + 1), delayMs)
    } else {
      logger.error(`[usage] se agotaron los reintentos para key=${idempotencyKey}, se descarta el reporte: ${err}`)
    }
  })
}
