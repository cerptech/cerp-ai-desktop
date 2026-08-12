import { randomUUID } from 'crypto'
import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
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
 *
 * Cola persistida (Ola 3): cada reporte se escribe a disco ANTES de intentar el POST
 * (mismo patrón JSON-file que tokenStore/customAgentStore) y se borra recién cuando
 * el backend confirma. Si se agotan los reintentos en memoria (servidor caído un
 * buen rato) el reporte NO se descarta — queda en el archivo y se reintenta solo la
 * próxima vez que la app arranque un agente con sesión válida (ver
 * flushPersistedQueue, enganchado a la primera llamada de initUsageReporter en cada
 * sesión de la app). Esto cubre el caso que antes perdía consumo: la app se cierra
 * (o crashea) con reportes en cola de reintento.
 */

const RETRY_DELAYS_MS = [1_000, 5_000, 25_000]

// Reportes más viejos que esto se consideran basura (server caído semanas, o un bug
// en el propio reporte) y se descartan al arrancar en vez de reintentarse para
// siempre — evita que el archivo crezca sin límite.
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000

const QUEUE_STORE_PATH = join(app.getPath('userData'), 'usage-queue.json')

interface QueuedUsageReport {
  idempotencyKey: string
  body: Record<string, unknown>
  /** Solo para diagnóstico / poda por antigüedad — no interviene en la lógica de reintento. */
  queuedAt: string
}

function readQueueFile(): QueuedUsageReport[] {
  try {
    const raw = JSON.parse(readFileSync(QUEUE_STORE_PATH, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeQueueFile(queue: QueuedUsageReport[]): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(QUEUE_STORE_PATH, JSON.stringify(queue, null, 2), 'utf-8')
  } catch (err) {
    logger.error(`[usage] no se pudo persistir la cola de consumo pendiente: ${err}`)
  }
}

// Cola en memoria, hidratada desde disco al cargar el módulo — sobrevive a que la
// app se cierre (o crashee) con reportes todavía sin confirmar.
let pendingQueue: QueuedUsageReport[] = readQueueFile()

function persistQueue(): void {
  writeQueueFile(pendingQueue)
}

function enqueue(entry: QueuedUsageReport): void {
  pendingQueue.push(entry)
  persistQueue()
}

function dequeue(idempotencyKey: string): void {
  const before = pendingQueue.length
  pendingQueue = pendingQueue.filter((e) => e.idempotencyKey !== idempotencyKey)
  if (pendingQueue.length !== before) persistQueue()
}

let httpClientRef: HttpClient | null = null
let sessionModel = 'unknown'
let sessionContextId: string | null = null
let hasFlushedOnStartup = false

export interface ExecutionUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd?: number
  turns?: number
  turbo?: boolean
}

/**
 * Fija el cliente HTTP, el modelo efectivo y el contexto de la sesión activa. Se
 * llama al arrancar cada ejecución del agente — la primera vez en la vida de la app
 * (con un httpClient ya autenticado) también dispara el reintento de lo que haya
 * quedado pendiente de una sesión anterior.
 */
export function initUsageReporter(httpClient: HttpClient, model: string, contextId: string | null = null): void {
  httpClientRef = httpClient
  sessionModel = model || 'unknown'
  sessionContextId = contextId

  if (!hasFlushedOnStartup) {
    hasFlushedOnStartup = true
    flushPersistedQueue()
  }
}

/** Reintenta lo que quedó persistido de una sesión anterior. Poda entradas demasiado viejas. */
function flushPersistedQueue(): void {
  const httpClient = httpClientRef
  if (!httpClient || pendingQueue.length === 0) return

  const now = Date.now()
  const stale = pendingQueue.filter((e) => now - new Date(e.queuedAt).getTime() > MAX_QUEUE_AGE_MS)
  for (const entry of stale) {
    logger.warn(`[usage] descartando reporte de consumo con más de 30 días en cola (key=${entry.idempotencyKey})`)
    dequeue(entry.idempotencyKey)
  }

  const toRetry = pendingQueue.filter((e) => !stale.includes(e))
  if (toRetry.length === 0) return

  logger.info(`[usage] reintentando ${toRetry.length} reporte(s) de consumo pendientes de una sesión anterior`)
  for (const entry of toRetry) {
    sendWithRetry(httpClient, entry.body, entry.idempotencyKey, 0)
  }
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

  // Escribir a disco ANTES de intentar el POST — si la app se cierra a mitad del
  // primer intento, el reporte igual sobrevive para el próximo arranque.
  enqueue({ idempotencyKey, body, queuedAt: new Date().toISOString() })

  sendWithRetry(httpClient, body, idempotencyKey, 0)
}

/**
 * Envía el reporte reintentando con backoff ante fallo. Misma `idempotencyKey` en
 * todos los intentos — el backend debita créditos una sola vez por esa key aunque
 * el POST se reintente. Fire-and-forget en cada paso: nunca hay un `await` que
 * bloquee al caller.
 */
function sendWithRetry(httpClient: HttpClient, body: Record<string, unknown>, idempotencyKey: string, attempt: number): void {
  httpClient.post('/usage', body).then(() => {
    dequeue(idempotencyKey)
  }).catch((err) => {
    if (attempt < RETRY_DELAYS_MS.length) {
      const delayMs = RETRY_DELAYS_MS[attempt]
      logger.warn(`[usage] reporte falló (intento ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}, key=${idempotencyKey}): ${err}. Reintentando en ${delayMs}ms`)
      setTimeout(() => sendWithRetry(httpClient, body, idempotencyKey, attempt + 1), delayMs)
    } else {
      // Se agotaron los reintentos EN ESTA SESIÓN — el reporte sigue en la cola
      // persistida (no se borra) y se reintenta solo en el próximo arranque de la
      // app (flushPersistedQueue), en vez de perderse como antes.
      logger.error(`[usage] se agotaron los reintentos de esta sesión para key=${idempotencyKey}; queda en cola persistida para el próximo arranque: ${err}`)
    }
  })
}
