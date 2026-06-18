import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Reporta el consumo de tokens por ejecución al backend (rentabilidad por cliente).
 *
 * agentManager captura el uso en cada mensaje `result` del SDK y lo reenvía acá.
 * El POST a /usage es fire-and-forget: un fallo al reportar nunca debe cortar ni
 * demorar el stream del agente. La empresa/usuario los resuelve el backend desde
 * el token autenticado (no se envían en el body), así un cliente no puede imputar
 * consumo a otro.
 */

let httpClientRef: HttpClient | null = null
let sessionModel = 'unknown'

export interface ExecutionUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd?: number
  turns?: number
  turbo?: boolean
  contextId?: string | null
}

/** Fija el cliente HTTP y el modelo efectivo de la sesión activa. */
export function initUsageReporter(httpClient: HttpClient, model: string): void {
  httpClientRef = httpClient
  sessionModel = model || 'unknown'
}

/** Persiste el consumo de una ejecución. No lanza: loguea y sigue. */
export function reportExecutionUsage(usage: ExecutionUsage): void {
  const httpClient = httpClientRef
  if (!httpClient) return

  const body = {
    model: sessionModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.costUsd ?? 0,
    turns: usage.turns ?? 0,
    turbo: usage.turbo ?? false,
    contextId: usage.contextId ?? undefined,
  }

  httpClient.post('/usage', body).catch((err) => {
    logger.warn(`[usage] no se pudo reportar el consumo de la ejecucion: ${err}`)
  })
}
