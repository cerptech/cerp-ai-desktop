import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createCerpMcpServer } from './mcpServer'
import { setAskUserWindow, cancelPendingQuestion, hasPendingQuestion } from './askUserBridge'
import { getActiveQuoteId, getActiveReservationId, stopAllQuoteHeartbeats, stopQuoteHeartbeat } from './quoteHeartbeat'
import { emitQuoteFirewallEvent, setQuoteEventWindow } from './quoteEventsBridge'
import { notifyUser, setNotifierWindow } from './desktopNotifier'
import { getLoadContext } from './loadContext'
import { buildRetryPrompt, classifyResult, describeTurnFailure, resultErrorDetail, type TurnFailureCode } from './turnOutcome'
import { setHtmlCanvasWindow, clearCanvases } from './htmlCanvasBridge'
import { initUsageReporter, reportExecutionUsage } from './usageReporter'
import { DesktopAccessDeniedError, getCompanyId, getUserId, fetchApiKey, getCompanySwitchSeq, getMaxBudgetUsd, getMaxBudgetUsdTurbo, NoCreditsError } from '../auth/apiKeyManager'
import { SYSTEM_PROMPT } from './systemPrompt'
import { CONSTRUCTION_AGENTS } from './agents'
import { customAgentStore } from '../store/customAgentStore'
import { HttpClient, NoActiveCompanyError, SessionRevokedError } from '../utils/httpClient'
import { COMPANY_CHANGED_SEND_MESSAGE, NO_ACTIVE_COMPANY_MESSAGE, shouldHoldSendForCompanyChange } from '../utils/sessionErrors'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AgentStreamEvent } from '../ipc/types'

// ============================================================
// MessageQueue — AsyncIterable that keeps the session alive
// ============================================================
class MessageQueue {
  private buffer: Array<{ type: 'user'; message: { role: 'user'; content: string } }> = []
  private waiting: ((result: IteratorResult<{ type: 'user'; message: { role: 'user'; content: string } }>) => void) | null = null
  private closed = false

  push(content: string): void {
    const msg = { type: 'user' as const, message: { role: 'user' as const, content } }
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.buffer.push(msg)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as any, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<{ type: 'user'; message: { role: 'user'; content: string } }> {
    return {
      next: (): Promise<IteratorResult<{ type: 'user'; message: { role: 'user'; content: string } }>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}

// ============================================================
// Persistent Streaming Sessions — one per conversation
// ============================================================
// CERP IA admite varias conversaciones corriendo en paralelo: cada una tiene su
// propia sesión del SDK (query + cola de mensajes + estado de turno). Antes esto
// eran variables de módulo (una sola sesión global); ahora viven en un Map keyed
// por conversationId. Una conversación que corre NO se mata al cambiar de pestaña.
interface AgentSession {
  conversationId: string
  query: any
  messageQueue: MessageQueue
  cwd: string
  contextId: string | null
  // Modelo con el que arrancó esta sesión (Ola 1 — selector de modelo). Igual que
  // cwd/contextId: si el usuario cambia de modelo mientras la conversación sigue
  // abierta, reiniciamos SOLO esa sesión para que el próximo mensaje use el modelo
  // nuevo (sendFollowUp no puede cambiarlo — el SDK fija el modelo al crear la query).
  model: string
  // true si esta sesión arrancó con modelChoice==='powerful' ("Potente"). Absorbe lo
  // que antes era el Modo Turbo global: effort 'xhigh', tool Workflow habilitada y
  // techo de presupuesto elevado. Se guarda por-sesión (no global) para que el
  // reporte de consumo (`mapMessage` → 'result') sepa qué modo corrió esta ejecución
  // aunque el usuario haya cambiado de modo mientras tanto.
  powerful: boolean
  // Empresa que el MCP de esta sesión inyecta en cada tool (se fija al crearla).
  // Multi-empresa (plan DK-1.1): si la empresa por defecto cambia (409
  // COMPANY_CHANGED), el turno en curso se detiene y el próximo mensaje reinicia
  // la sesión con la empresa nueva — nunca sigue escribiendo con la vieja.
  companyId: string | null
  processingTurn: boolean
  // Registro de delegaciones activas: Agent/Task tool_use_id → agentName. Por-sesión
  // para que los eventos internos de subagentes resuelvan el nombre correcto.
  activeDelegations: Map<string, string>
  heartbeat: ReturnType<typeof setInterval> | null
  // total_cost_usd y num_turns del SDK son ACUMULADOS de la sesión: para reportar
  // consumo por ejecución hay que restar lo ya reportado (si no, el summary del
  // backend suma acumulados y multiplica el gasto real).
  lastReportedCostUsd: number
  lastReportedTurns: number
  // ── Desenlace garantizado del turno (RQM-166) ─────────────────────────────
  httpClient: HttpClient
  /** Último mensaje recibido del SDK (cualquiera, incluidos los de subagentes). */
  lastActivityAt: number
  turnStartedAt: number
  /** El turno en curso ya terminó en error (se avisó al usuario): no se avisa dos veces. */
  turnFailed: boolean
  /** El usuario (Detener) o el cambio de empresa interrumpieron el turno: el abort no es un error. */
  interruptRequested: boolean
  /** closeSession en curso: lo que tire el stream al cerrarse no es un error del turno. */
  closing: boolean
  /** `done` retenido mientras quedaban tareas de fondo (ver processStreamLoop). */
  heldDone: AgentStreamEvent | null
  heldDoneTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, AgentSession>()

/**
 * Watchdog de turno (RQM-166): si el SDK no manda NINGÚN mensaje durante este tiempo
 * mientras hay un turno o una tarea de fondo en curso, el turno se da por colgado: se
 * corta, se libera la reserva de la cotización y se avisa con un error accionable.
 * 15 min deja margen sobre lo que puede tardar legítimamente sin emitir nada (un Bash
 * llega a 10 min; una llamada al core, a 5). No corre mientras se espera al usuario.
 * `CERP_TURN_TIMEOUT_MS` lo baja para probar el caso en QA.
 */
const TURN_INACTIVITY_TIMEOUT_MS = Number(process.env.CERP_TURN_TIMEOUT_MS) || 15 * 60_000
/** Con el último task_notification, si el SDK no arranca otro turno en este plazo se libera el `done` retenido. */
const HELD_DONE_GRACE_MS = 30_000
/** Un turno más largo que esto avisa por notificación del sistema al terminar (si la ventana no tiene foco). */
const LONG_TURN_NOTIFY_MS = 2 * 60_000

/** Todo evento al renderer va etiquetado con su conversación. */
function emitToRenderer(conversationId: string, event: AgentStreamEvent): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, { conversationId, event })
  }
}

function emitDoneToRenderer(conversationId: string): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, { conversationId })
  }
}

/** Marca el arranque de un turno: el watchdog cuenta desde acá, aunque el SDK todavía no haya respondido. */
function beginTurn(session: AgentSession): void {
  const now = Date.now()
  session.turnStartedAt = now
  session.lastActivityAt = now
  session.turnFailed = false
  session.interruptRequested = false
  session.processingTurn = true
  session.heldDone = null
  if (session.heldDoneTimer) { clearTimeout(session.heldDoneTimer); session.heldDoneTimer = null }
  const quoteId = getActiveReservationId(session.conversationId)
  if (quoteId) emitQuoteFirewallEvent({ kind: 'resumed', conversationId: session.conversationId, quoteId })
}

/**
 * Libera la reserva abierta de una carga que se cortó por un fallo nuestro: el crédito
 * no se consume y el presupuesto parcial queda como borrador (CreditFirewallService del
 * core). Si el refund falla, el heartbeat ya está detenido y el watchdog del core la
 * refunda igual a los 15 min.
 */
async function releaseReservationAfterFailure(session: AgentSession, message: string): Promise<void> {
  const conversationId = session.conversationId
  const quoteId = getActiveReservationId(conversationId)
  if (!quoteId) return
  stopQuoteHeartbeat(conversationId)
  try {
    await session.httpClient.post(`/quotes/${quoteId}/refund`, { reason: 'error' })
    logger.info(`Reserva ${quoteId} liberada tras el fallo del turno (${conversationId})`)
  } catch (err) {
    logger.warn(`No se pudo liberar la reserva ${quoteId} (la libera el watchdog del core): ${err instanceof Error ? err.message : String(err)}`)
  }
  emitQuoteFirewallEvent({ kind: 'rolled_back', conversationId, quoteId, reason: 'error', message, failures: [], cause: 'system' })
}

/**
 * El turno terminó en error: avisa UNA vez con un mensaje accionable (+ el prompt de
 * Reintentar), libera la reserva y notifica al sistema. No cierra la sesión: lo decide
 * el caller (el watchdog la cierra en el acto; un `result` de error, después del `done`).
 */
function failTurn(session: AgentSession, code: TurnFailureCode, detail: string): void {
  if (session.turnFailed) return
  session.turnFailed = true
  const conversationId = session.conversationId
  const ctx = getLoadContext(conversationId)
  const inLoad = !!getActiveReservationId(conversationId) || !!ctx
  const failure = describeTurnFailure(code, inLoad, Math.round(TURN_INACTIVITY_TIMEOUT_MS / 60_000))
  logger.error(`Turno fallido [${conversationId}] ${code}: ${detail}`)
  emitToRenderer(conversationId, { type: 'error', code, message: failure.message, retryPrompt: buildRetryPrompt(ctx) })
  void releaseReservationAfterFailure(session, failure.message)
  notifyUser('CERP IA se detuvo', failure.short)
}

/** Cierre normal de un turno: libera la UI y, si la cotización quedó abierta, la marca en pausa. */
function finishTurn(session: AgentSession, doneEvent: AgentStreamEvent): void {
  const conversationId = session.conversationId
  session.heldDone = null
  if (session.heldDoneTimer) { clearTimeout(session.heldDoneTimer); session.heldDoneTimer = null }
  emitToRenderer(conversationId, doneEvent)
  emitDoneToRenderer(conversationId)
  session.processingTurn = false
  if (session.turnFailed) return
  const quoteId = getActiveReservationId(conversationId)
  if (quoteId) emitQuoteFirewallEvent({ kind: 'paused', conversationId, quoteId })
  if (Date.now() - session.turnStartedAt > LONG_TURN_NOTIFY_MS) {
    if (quoteId) notifyUser('CERP IA espera tu respuesta', 'La carga del presupuesto está en pausa hasta que respondas en la conversación.')
    else notifyUser('CERP IA terminó', 'La respuesta ya está en la conversación.')
  }
}
let mainWindowRef: BrowserWindow | null = null

// Conversaciones que arrancan antes de tener id real (legacy / primer mensaje)
// usan esta clave efímera.
const DEFAULT_CONV = '__default__'

// Plan Mode — global (es un toggle de UI, no por-conversación). When true the
// agent cannot execute write operations; the user reviews the plan and resumes.
let planModeEnabled = false

export function getPlanMode(): boolean {
  return planModeEnabled
}

/**
 * Enable or disable Plan Mode.
 * Plan Mode es global, así que al cambiarlo cerramos TODAS las sesiones abiertas
 * para que el próximo mensaje de cada conversación arranque con el modo nuevo.
 */
export function setPlanMode(enabled: boolean): void {
  if (planModeEnabled === enabled) return
  planModeEnabled = enabled
  logger.info(`Plan Mode ${enabled ? 'enabled' : 'disabled'}`)
  // La conversación sigue (el próximo mensaje reabre la sesión): una cotización
  // en curso conserva su reserva.
  for (const id of [...sessions.keys()]) closeSession(id, { keepReservation: true })
}

export function isAgentRunning(): boolean {
  for (const s of sessions.values()) if (s.processingTurn) return true
  return false
}

export function hasActiveSession(): boolean {
  return sessions.size > 0
}

/**
 * Interrupt a conversation's current turn gracefully (agent can finish current thought).
 */
export async function interruptAgent(conversationId: string = DEFAULT_CONV): Promise<void> {
  const session = sessions.get(conversationId)
  if (!session) return
  // El `result` abortado que sigue NO es un fallo: lo pidió el usuario (o el cambio de empresa).
  session.interruptRequested = true
  try {
    await session.query.interrupt()
    logger.info(`Agent interrupted (${conversationId})`)
  } catch (err) {
    logger.warn(`Interrupt failed, closing session (${conversationId}): ${err}`)
    closeSession(conversationId)
  }
}

/**
 * Close one conversation's session entirely and clean up.
 * `keepReservation`: la conversación sigue (reinicio por cambio de carpeta/modelo/Plan
 * Mode) — la reserva de una cotización en curso no se suelta.
 */
export function closeSession(conversationId: string = DEFAULT_CONV, opts: { keepReservation?: boolean } = {}): void {
  const session = sessions.get(conversationId)
  if (!session) return
  session.closing = true
  // Cancel any pending ask_user_question for THIS conversation so the MCP promise doesn't hang
  cancelPendingQuestion(conversationId)
  // Stop the credit reservation heartbeat — if a quote was mid-flight, the backend
  // watchdog will refund it on heartbeat timeout (no credit lost to an aborted run).
  if (!opts.keepReservation) stopQuoteHeartbeat(conversationId)
  try { session.messageQueue.close() } catch { /* ignore */ }
  try { session.query.close() } catch { /* ignore */ }
  if (session.heartbeat) clearInterval(session.heartbeat)
  if (session.heldDoneTimer) clearTimeout(session.heldDoneTimer)
  session.activeDelegations.clear()
  sessions.delete(conversationId)
  logger.info(`Session closed (${conversationId})`)
}

/** Close every active session (logout / global reset). */
export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id)
  stopAllQuoteHeartbeats()
  cachedContextPrompt = null
  setAskUserWindow(null)
  setHtmlCanvasWindow(null)
  clearCanvases()
  logger.info('All sessions closed')
}

/**
 * Multi-empresa (plan DK-1.1): la empresa por defecto cambió (409 COMPANY_CHANGED).
 * Detiene el turno de cada sesión que arrancó con otra empresa — así ninguna tool
 * que NO inyecta `companyId` (y que el core resolvería en la empresa nueva) sigue
 * escribiendo en este turno — y tira el contexto de empresa cacheado del prompt.
 * Las sesiones no se cierran: `runAgent` las reinicia en el próximo mensaje porque
 * su `companyId` ya no coincide. Con `companyId` desconocido (null) se detienen todas.
 */
export function stopSessionsNotInCompany(companyId: string | null): void {
  cachedContextPrompt = null
  for (const session of [...sessions.values()]) {
    if (companyId !== null && session.companyId === companyId) continue
    if (!session.processingTurn) continue
    logger.warn(`Empresa por defecto cambiada — se detiene el turno en curso (${session.conversationId})`)
    void interruptAgent(session.conversationId)
  }
}

// Alias for IPC compatibility. Sin id → cierra todo (logout). Con id → esa conversación.
export function resetSession(conversationId?: string): void {
  if (conversationId) closeSession(conversationId)
  else closeAllSessions()
}

export function abortAgent(conversationId: string = DEFAULT_CONV): void {
  interruptAgent(conversationId)
}

/**
 * Send a message to a conversation's agent. Starts a new session if needed.
 * Each conversationId has its own SDK session; sending to one never disturbs others.
 */
export async function runAgent(
  payload: SendPromptPayload,
  apiKey: string,
  model: string,
  httpClient: HttpClient,
  mainWindow: BrowserWindow,
): Promise<void> {
  mainWindowRef = mainWindow
  setAskUserWindow(mainWindow)
  setQuoteEventWindow(mainWindow)
  setHtmlCanvasWindow(mainWindow)
  setNotifierWindow(mainWindow)
  const conversationId = payload.conversationId || DEFAULT_CONV
  const cwd = payload.cwd || app.getPath('home')
  const contextId = payload.activeContextId || null

  let session = sessions.get(conversationId)

  // Bug encontrado al consolidar Turbo en "Potente" (verificación e2e de la cadena de
  // modos): el restart de sesión comparaba solo el STRING del modelo resuelto. Eso es
  // insuficiente ahora que "Potente" también cambia effort/tools/budget (antes eso lo
  // garantizaba el toggle global de Turbo, que SIEMPRE cerraba todas las sesiones sin
  // depender del string). Si "Auto" llegara a resolver al mismo modelo que "Potente"
  // (p.ej. el plan de la empresa configura Opus como default), cambiar Auto→Potente no
  // hubiera reiniciado la sesión y el turno siguiente hubiera seguido con effort/tools
  // viejos. Comparamos también el flag `powerful` explícitamente para cerrar ese hueco.
  const powerful = payload.modelChoice === 'powerful'

  // If THIS conversation's session exists but cwd/context/model/powerful changed,
  // restart only it. Other conversations' sessions are untouched — that's the point
  // of concurrency.
  // La empresa también: tras un 409 COMPANY_CHANGED la config ya trae la nueva (o
  // quedó vacía si el refetch falló, y startSession la vuelve a pedir).
  if (session && (cwd !== session.cwd || contextId !== session.contextId || model !== session.model || powerful !== session.powerful || getCompanyId() !== session.companyId)) {
    logger.info(`Session options changed, restarting session (${conversationId})`)
    closeSession(conversationId, { keepReservation: true })
    session = undefined
  }

  if (!session) {
    await startSession(conversationId, payload, apiKey, model, httpClient, mainWindow, cwd, contextId)
  } else {
    sendFollowUp(session, payload.prompt)
  }
}

// ============================================================
// Session lifecycle
// ============================================================

/**
 * El arranque de una sesión se cortó antes de crearla (paywall, cuenta sin empresa,
 * sesión revocada, cambio de empresa): un error con código distinguible + DONE, así
 * el renderer sale del estado "pendiente" y reacciona según el código.
 */
function emitStartAborted(mainWindow: BrowserWindow, conversationId: string, message: string, code: string): void {
  if (mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, {
    conversationId,
    event: { type: 'error', message, code },
  })
  mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, { conversationId })
}

async function startSession(
  conversationId: string,
  payload: SendPromptPayload,
  apiKey: string,
  model: string,
  httpClient: HttpClient,
  mainWindow: BrowserWindow,
  cwd: string,
  contextId: string | null,
): Promise<void> {
  // Get companyId + userId
  let companyId = getCompanyId()
  let userId = getUserId()
  if (!companyId || !userId) {
    // Multi-empresa (pulido de DK1): este fetch corre DESPUÉS de la retención del envío
    // en AGENT_SEND_PROMPT (p.ej. companyId A persistido sin userId en un store viejo).
    // Si trae otra empresa, el prompt se escribió para la vieja: no se corre.
    const companySwitchSeqBefore = getCompanySwitchSeq()
    try {
      const config = await fetchApiKey(httpClient)
      companyId = config.companyId || null
      userId = config.userId || null
    } catch (err) {
      // La cuenta se quedó sin empresas entre el gate de handlers.ts y este arranque:
      // el guard de sesión ya cerró la sesión y avisó. No se arranca una sesión con
      // companyId null (como el paywall de abajo).
      if (err instanceof NoActiveCompanyError || err instanceof SessionRevokedError) {
        const code = err instanceof NoActiveCompanyError ? 'NO_ACTIVE_COMPANY' : 'AUTH_EXPIRED'
        const message = err instanceof NoActiveCompanyError ? NO_ACTIVE_COMPANY_MESSAGE : 'No se pudo recuperar la sesión. Inicia sesión de nuevo.'
        logger.warn(`startSession aborted (${conversationId}): ${code}`)
        emitStartAborted(mainWindow, conversationId, message, code)
        return
      }
      // Paywall (Modelo CERP): la empresa se quedó sin créditos entre el gate de
      // handlers.ts y el arranque de esta sesión (p.ej. companyId/userId no estaban
      // cacheados todavía). A diferencia de un fallo de red/config, esto NO es
      // recuperable con datos parciales — cortamos acá con un evento distinguible
      // en vez de arrancar una sesión rota.
      if (err instanceof NoCreditsError) {
        logger.warn(`startSession aborted (${conversationId}): no credits available`)
        emitStartAborted(mainWindow, conversationId, err.message, 'NO_CREDITS')
        return
      }
      if (err instanceof DesktopAccessDeniedError) {
        logger.warn(`startSession aborted (${conversationId}): access denied (${err.reason})`)
        emitStartAborted(mainWindow, conversationId, err.message, err.code)
        return
      }
      logger.warn(`Could not fetch config: ${err}`)
    }
    if (shouldHoldSendForCompanyChange(companySwitchSeqBefore, getCompanySwitchSeq(), false)) {
      // El observer del guard ya detuvo los turnos viejos y manda el aviso.
      logger.warn(`startSession aborted (${conversationId}): la config trajo otra empresa por defecto`)
      emitStartAborted(mainWindow, conversationId, COMPANY_CHANGED_SEND_MESSAGE, 'COMPANY_CHANGED')
      return
    }
  }
  logger.info(`CompanyId: ${companyId}, UserId: ${userId}`)

  // "Potente" (Ola 1 selector) absorbe lo que antes era el Modo Turbo (pill separada,
  // eliminada): raise execution rigor for complex quotes — xhigh effort + the Workflow
  // tool + a higher budget ceiling. `model` ya llega resuelto a Opus por resolveModel()
  // en handlers.ts cuando modelChoice==='powerful'; acá solo derivamos effort/tools/budget.
  const powerful = payload.modelChoice === 'powerful'
  const effort = powerful ? 'xhigh' : 'medium'
  if (powerful) {
    logger.info(`Modo Potente activo — model=${model}, effort=${effort}, workflows habilitados`)
  }

  // Reporte de consumo de tokens por ejecución (rentabilidad por cliente).
  // Fija el cliente HTTP + el modelo efectivo + el contexto; mapMessage reporta en cada `result`.
  initUsageReporter(httpClient, model, contextId)

  const cerpMcpServer = createCerpMcpServer(httpClient, companyId, userId, conversationId)
  const contextPrompt = await buildContextPrompt(httpClient)
  const fullSystemPrompt = buildFullSystemPrompt(
    contextPrompt,
    contextId,
    payload.activeContextId,
    planModeEnabled,
    payload.conversationHistory,
    powerful,
  )

  // Build subagent definitions (with model overrides for cost optimization).
  // Política de modelo (ADR 016): ningún subagente puede correr por encima del
  // tier del modelo principal (que ya llega resuelto por la política: Auto,
  // techo y umbral). Con el principal en Haiku, 'sonnet'/'opus' bajan a
  // 'haiku'; con el principal en Sonnet, 'opus' baja a 'sonnet' — si no, la
  // degradación o el techo se escaparían por los especialistas.
  const mainTierRank = /haiku/i.test(model) ? 0 : /opus/i.test(model) ? 2 : 1
  const clampSubagentModel = (m: 'sonnet' | 'opus' | 'haiku'): 'sonnet' | 'opus' | 'haiku' => {
    const rank = m === 'haiku' ? 0 : m === 'sonnet' ? 1 : 2
    const clamped = Math.min(rank, mainTierRank)
    return clamped === 0 ? 'haiku' : clamped === 1 ? 'sonnet' : 'opus'
  }
  const builtInAgents = CONSTRUCTION_AGENTS.map((a) => ({
    name: a.name,
    description: a.description,
    instructions: a.prompt,
    ...(a.model && a.model !== 'inherit' ? { model: clampSubagentModel(a.model) } : {}),
  }))
  const customAgentDefs = customAgentStore.getAgents()
  const customSdkAgents = customAgentDefs.map((a) => ({
    name: a.name,
    description: a.description,
    instructions: a.systemPrompt,
  }))

  // SDK 0.3.x no longer ships a bundled `cli.js`. It spawns a NATIVE Claude Code binary
  // shipped as a per-platform optional dependency (e.g. @anthropic-ai/claude-agent-sdk-win32-x64/claude.exe).
  // We resolve that binary explicitly because Electron's asar / require.resolve can't find it
  // reliably (see the SDK README note on bundled executables).
  // npm may HOIST the platform package to the top-level node_modules (dev) or NEST it under
  // claude-agent-sdk/node_modules (production CI build) — the layout is non-deterministic, so we
  // probe both. NOTE: linux-musl variants are not distinguished here (glibc assumed).
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const appRoot = join(__dirname, '..', '..').replace('app.asar', 'app.asar.unpacked')
  const fsMod = require('fs')
  const binCandidates = [
    // hoisted (typical in dev)
    join(appRoot, 'node_modules', '@anthropic-ai', platformPkg, binName),
    // nested under the SDK package (typical in the packaged CI build)
    join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', platformPkg, binName),
  ]
  const sdkCliPath = binCandidates.find((p: string) => fsMod.existsSync(p)) ?? binCandidates[0]

  logger.info(`SDK native binary path: ${sdkCliPath} (exists: ${fsMod.existsSync(sdkCliPath)})`)
  logger.info(`Electron execPath: ${process.execPath}`)

  const options: Record<string, unknown> = {
    model,
    systemPrompt: fullSystemPrompt,
    cwd,
    pathToClaudeCodeExecutable: sdkCliPath,
    // SDK 0.3.x: spawn the NATIVE Claude Code binary directly (no Electron-as-node / cli.js).
    spawnClaudeCodeProcess: (spawnOpts: any) => {
      const { spawn } = require('child_process')
      // Find git-bash — required by Claude Code on Windows
      let gitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH || ''
      if (!gitBashPath && process.platform === 'win32') {
        const { existsSync } = require('fs')
        const candidates = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
        ]
        for (const p of candidates) {
          if (existsSync(p)) { gitBashPath = p; break }
        }
        if (gitBashPath) logger.info(`Found git-bash at: ${gitBashPath}`)
        else logger.warn('git-bash not found in standard locations')
      }
      const spawnEnv = {
        ...process.env,
        ...(spawnOpts?.options?.env || {}),
        ANTHROPIC_API_KEY: apiKey,
        ...(gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: gitBashPath } : {}),
      }
      // The native binary doesn't run under Electron's Node — strip the flag if present.
      delete (spawnEnv as Record<string, unknown>).ELECTRON_RUN_AS_NODE
      const spawnArgs = spawnOpts?.args || []
      const spawnCwd = spawnOpts?.options?.cwd || cwd
      logger.info(`Spawning native CLI: ${sdkCliPath} ${spawnArgs.join(' ').slice(0, 100)}`)
      const child = spawn(
        sdkCliPath,
        spawnArgs,
        { ...spawnOpts?.options, cwd: spawnCwd, env: spawnEnv },
      )
      // Capture stderr to diagnose non-zero exits
      child.stderr?.on('data', (data: Buffer) => {
        logger.error(`CLI stderr: ${data.toString().trim()}`)
      })
      child.on('exit', (code: number | null) => {
        if (code && code !== 0) logger.error(`CLI process exited with code ${code}`)
      })
      return child
    },
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
    },
    mcpServers: {
      cerp: cerpMcpServer,
    },
    agents: [...builtInAgents, ...customSdkAgents],
    allowedTools: [
      'Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__cerp__*', 'mcp__cerp__ask_user_question',
      // Potente: habilita la orquestación de workflows dinámicos para cotizaciones grandes
      // (absorbe lo que antes hacía el Modo Turbo).
      ...(powerful ? ['Workflow'] : []),
    ],
    // La tool nativa `AskUserQuestion` del SDK espera que el host responda por
    // canUseTool, y Desktop no lo hace: en las conversaciones de Camacho (2026-09) todas
    // sus llamadas terminaron en error y el agente quedaba anunciando preguntas que nunca
    // aparecían. Las preguntas van SOLO por nuestro widget (mcp__cerp__ask_user_question),
    // que el prompt nombra casi igual — el modelo las confundía.
    disallowedTools: ['AskUserQuestion'],
    // Potente: orquestación de workflows dinámicos (MVP conservador, sin ultracode).
    enableWorkflows: powerful,
    // NOTE: we never use permissionMode:'plan' because the SDK then auto-injects
    // the ExitPlanMode tool, which conflicts with our ask_user_question flow.
    // Instead, when planModeEnabled is true we inject a strict directive into
    // the system prompt that forbids write tools and ExitPlanMode (see
    // buildFullSystemPrompt). The user controls the toggle from the UI.
    permissionMode: 'bypassPermissions',
    maxTurns: payload.maxTurns ?? 100,
    // Potente gasta más (Opus + xhigh + workflows): subimos el techo de forma consciente.
    // Prioridad: payload explícito > techo por plan (backend, Modelo CERP) > hardcode legacy.
    maxBudgetUsd: payload.maxBudgetUsd ?? (powerful ? (getMaxBudgetUsdTurbo() ?? 25.0) : (getMaxBudgetUsd() ?? 10.0)),
    includePartialMessages: true,
    promptSuggestions: true,
    // 'medium' keeps the agent responsive: 'high' triggers long extended-reasoning
    // pauses with no visible output, which reads as "frozen" in a live desktop UI.
    // Potente opts INTO that trade-off ('xhigh') for complex quotes — the heartbeat
    // below mitigates the silent pauses.
    effort,
    // Fase 2: forward subagent text/reasoning deltas so we can render them
    // inside the delegation card in real-time. Requires SDK >= 0.2.119.
    // When true, assistant messages from subagents (parent_tool_use_id set)
    // include full text blocks, not just tool_use/tool_result heartbeats.
    forwardSubagentText: true,
  }

  logger.info(`Starting session (${conversationId}): "${payload.prompt.slice(0, 80)}..." (cwd: ${cwd}, planMode: ${planModeEnabled})`)

  // Create persistent message queue — keeps the session alive between turns
  const messageQueue = new MessageQueue()
  messageQueue.push(payload.prompt)

  const activeQuery = query({
    prompt: messageQueue as any,
    options: options as any,
  })

  const session: AgentSession = {
    conversationId,
    query: activeQuery,
    messageQueue,
    cwd,
    contextId,
    model,
    powerful,
    companyId,
    processingTurn: false,
    activeDelegations: new Map(),
    heartbeat: null,
    lastReportedCostUsd: 0,
    lastReportedTurns: 0,
    httpClient,
    lastActivityAt: Date.now(),
    turnStartedAt: Date.now(),
    turnFailed: false,
    interruptRequested: false,
    closing: false,
    heldDone: null,
    heldDoneTimer: null,
  }
  sessions.set(conversationId, session)
  beginTurn(session)

  // Process stream in background
  processStreamLoop(session)
}

function sendFollowUp(session: AgentSession, prompt: string): void {
  logger.info(`Sending follow-up (${session.conversationId}): "${prompt.slice(0, 80)}..."`)
  beginTurn(session)
  session.messageQueue.push(prompt)
}

// ============================================================
// Stream processing (runs in background)
// ============================================================

async function processStreamLoop(session: AgentSession): Promise<void> {
  if (!mainWindowRef) return
  const conversationId = session.conversationId

  // Every IPC event is tagged with conversationId so the renderer routes it to the
  // right conversation — that's what lets background conversations keep streaming.
  const sendEvent = (event: AgentStreamEvent): void => emitToRenderer(conversationId, event)
  const sendDone = (): void => emitDoneToRenderer(conversationId)

  let activeTaskCount = 0

  // Heartbeat + watchdog. The for-await loop BLOCKS while awaiting the next SDK message,
  // so during a multi-minute pause (e.g. a background subagent generating with no parent
  // stream_events) nothing is forwarded. Every 5s, WHILE a turn or a background task is
  // in progress, this interval:
  //  - forwards a lightweight `heartbeat` so the renderer's stall timer knows the main
  //    process is alive and the agent is working;
  //  - checks the SDK is ALSO alive: with no SDK message for TURN_INACTIVITY_TIMEOUT_MS
  //    the turn is hung (RQM-166: a subagent whose task never notified kept the UI on
  //    "trabajando" for days). It fails the turn and closes the session. Waiting on the
  //    user (ask_user_question / schedule confirmation) does not count as inactivity.
  session.heartbeat = setInterval(() => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    if (!(activeTaskCount > 0 || session.processingTurn) || session.closing) return
    if (hasPendingQuestion(conversationId)) {
      session.lastActivityAt = Date.now()
    } else if (Date.now() - session.lastActivityAt >= TURN_INACTIVITY_TIMEOUT_MS) {
      const idleMin = Math.round((Date.now() - session.lastActivityAt) / 60_000)
      failTurn(session, 'TURN_TIMEOUT', `sin mensajes del SDK hace ${idleMin} min (tareas de fondo=${activeTaskCount}, processingTurn=${session.processingTurn})`)
      // Una sesión colgada no se puede "interrumpir" con confianza (el SDK puede estar
      // esperando una tool que no vuelve): se cierra. El próximo mensaje (Reintentar)
      // abre una sesión nueva con el historial de la conversación.
      closeSession(conversationId)
      return
    }
    sendEvent({ type: 'heartbeat' })
  }, 5000)

  // Releases a `done` that was held for background tasks once the last one notified and
  // the SDK did not start a follow-up turn on its own (otherwise the UI would stay busy
  // and the watchdog would report a hang that isn't one).
  const scheduleHeldDoneRelease = (): void => {
    if (!session.heldDone || session.heldDoneTimer) return
    session.heldDoneTimer = setTimeout(() => {
      session.heldDoneTimer = null
      if (session.heldDone && activeTaskCount === 0 && !session.closing) {
        logger.info(`Releasing held done (${conversationId}): no follow-up turn after background tasks`)
        finishTurn(session, session.heldDone)
      }
    }, HELD_DONE_GRACE_MS)
  }

  try {
    for await (const msg of session.query) {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) break
      session.lastActivityAt = Date.now()

      const msgObj = msg as Record<string, unknown>
      const msgType = msgObj.type as string
      const msgSubtype = msgObj.subtype as string | undefined
      const parentToolUseId = parentToolUseIdOf(msgObj)

      logger.debug(`Stream[${conversationId}]: type=${msgType} subtype=${msgSubtype || '-'} tasks=${activeTaskCount}`)

      // Track background tasks and system events
      if (msgType === 'system') {
        if (msgSubtype === 'task_started') {
          activeTaskCount++
          session.processingTurn = true
          // Bug #2 fix: send an explicit stream_start event so the renderer
          // badge flips to "activa" immediately, regardless of whether
          // isStreaming was reset by a stale done event from a prior turn.
          sendEvent({ type: 'stream_start' })
          logger.info(`Background task started (${activeTaskCount} active)`)
        } else if (msgSubtype === 'task_notification') {
          activeTaskCount = Math.max(0, activeTaskCount - 1)
          const status = (msgObj as { status?: string }).status ?? 'completed'
          if (status !== 'completed') logger.warn(`Background task ${status}: ${String((msgObj as { summary?: string }).summary ?? '').slice(0, 300)}`)
          logger.info(`Background task ${status} (${activeTaskCount} remaining)`)
          if (activeTaskCount === 0) scheduleHeldDoneRelease()
        } else if (msgSubtype === 'api_retry') {
          // SDK is retrying an API call — show feedback so UI doesn't look stuck
          sendEvent({ type: 'status', message: 'Reconectando con el servidor...' })
          logger.warn('API retry in progress')
        }
      }

      // Track turn state (the heartbeat interval handles keep-alive during silent gaps)
      if (msgType === 'assistant' || msgType === 'stream_event') {
        session.processingTurn = true
        // A follow-up turn of the main agent started (typically to process a background
        // task's result): it ends with its own `result`, so the held `done` is superseded.
        if (session.heldDone && !parentToolUseId) {
          session.heldDone = null
          if (session.heldDoneTimer) { clearTimeout(session.heldDoneTimer); session.heldDoneTimer = null }
        }
      }

      // ── Subagent inner activity routing ──────────────────────────────────
      // Messages from inside a subagent carry parent_tool_use_id = the Agent
      // tool_use_id that spawned them. We route these to dedicated subagent
      // events instead of discarding them.
      if (parentToolUseId) {
        const agentName = session.activeDelegations.get(parentToolUseId) ?? 'agente'

        if (msgType === 'assistant') {
          // The subagent is making tool calls and/or writing text.
          const message = msgObj.message as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } | undefined
          if (message?.content) {
            for (const block of message.content) {
              if (block.type === 'tool_use' && block.name && block.id) {
                // Inner tool call by the subagent — keyed by its own tool_use id.
                sendEvent({
                  type: 'subagent_tool_start',
                  parentToolUseId,
                  toolUseId: block.id,
                  agentName,
                  name: block.name,
                  input: extractInputStr(block.input as Record<string, unknown> | undefined),
                })
                logger.debug(`Subagent ${agentName}: tool_start ${block.name} (${block.id})`)
              } else if (block.type === 'text' && block.text) {
                // forwardSubagentText: text/reasoning from the subagent in real-time
                sendEvent({
                  type: 'subagent_text',
                  parentToolUseId,
                  agentName,
                  text: block.text,
                })
              }
            }
          }
        } else if (msgType === 'user') {
          // The subagent's tool RESULTS arrive as `user` messages whose content blocks
          // are tool_result (NOT a top-level tool_result message). Key done by tool_use_id.
          const message = msgObj.message as { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } | undefined
          for (const block of message?.content ?? []) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              sendEvent({
                type: 'subagent_tool_done',
                parentToolUseId,
                toolUseId: block.tool_use_id,
                output: extractToolResultOutput(block.content),
                isError: block.is_error,
              })
              logger.debug(`Subagent ${agentName}: tool_done (${block.tool_use_id})`)
            }
          }
        }
        continue
      }

      // A `result` that is not a clean success (max turns, budget ceiling, execution
      // error, API error) used to reach the UI as a silent `done` (RQM-166). Classify it
      // here; the `done` handling below turns it into an actionable error.
      let resultFailure: TurnFailureCode | null = null
      if (msgType === 'result') {
        const outcome = classifyResult(msgObj)
        if (outcome) logger.warn(`Result con error [${conversationId}]: ${resultErrorDetail(msgObj)}`)
        if (outcome === 'ABORTED') {
          // Detener / cambio de empresa / watchdog: no es un fallo que avisar. Un abort
          // que nadie pidió, sí.
          if (!session.interruptRequested && !session.turnFailed) resultFailure = 'EXECUTION_ERROR'
        } else if (outcome) {
          resultFailure = outcome
        }
      }

      // Map and forward events
      const events = mapMessage(msgObj, session.activeDelegations, session)
      if (events) {
        const arr = Array.isArray(events) ? events : [events]
        for (const event of arr) {
          if (event.type === 'done') {
            logger.info(`Turn complete [${conversationId}] (cost=$${(event as any).cost?.toFixed(4) || '?'}, tasks=${activeTaskCount}, failure=${resultFailure ?? '-'})`)
            if (resultFailure) {
              // The turn is over and failed: no waiting for background tasks. Error first
              // (with the retry prompt), then the usual done. The session is closed so the
              // retry starts fresh — after a max-turns / budget-ceiling result the same
              // query would fail again right away.
              failTurn(session, resultFailure, resultErrorDetail(msgObj))
              finishTurn(session, event)
              closeSession(conversationId)
              continue
            }
            if (activeTaskCount > 0 && !session.interruptRequested) {
              // Background tasks still running — don't signal done to UI yet. The watchdog
              // covers a task that never notifies; scheduleHeldDoneRelease, a task that
              // notifies without the SDK starting a follow-up turn. (After Detener the turn
              // is over for the user: nothing is held.)
              session.heldDone = event
              logger.info(`Holding done: ${activeTaskCount} tasks still active`)
              continue
            }
            // Turn complete and no background tasks — unlock UI for next input
            // Session stays alive (MessageQueue keeps the query running)
            finishTurn(session, event)
            continue
          }
          sendEvent(event)
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (session.closing || session.turnFailed) {
      // closeSession (watchdog, failed result, logout): what the stream throws while
      // closing is not news for the user.
      logger.info(`Stream closed (${conversationId}): ${message}`)
    } else if (message.includes('aborted') || message.includes('interrupt')) {
      logger.info(`Session interrupted/aborted (${conversationId})`)
      sendEvent({ type: 'done' })
    } else {
      logger.error(`Stream error (${conversationId}): ${message}`)
      failTurn(session, 'PROCESS_ERROR', message)
    }
    sendDone()
  } finally {
    // The stream ended in the middle of a turn without a `result` and nobody closed it
    // (e.g. the CLI process died): that turn has no outcome yet — give it one.
    if (session.processingTurn && !session.closing && !session.turnFailed && !session.interruptRequested) {
      failTurn(session, 'PROCESS_ERROR', 'el stream del SDK terminó sin result')
    }
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null }
    if (session.heldDoneTimer) { clearTimeout(session.heldDoneTimer); session.heldDoneTimer = null }
    session.processingTurn = false
    // The for-await loop only ends when the message queue closes (closeSession) or the
    // stream errors — the session is truly over, so drop it from the registry (only if
    // it is still THIS session: a retry may already have opened the next one).
    if (sessions.get(conversationId) === session) sessions.delete(conversationId)
    // Always ensure UI resets — covers budget exceeded, errors, etc.
    sendEvent({ type: 'done' })
    sendDone()
    logger.info(`Stream loop ended (${conversationId})`)
  }
}

function parentToolUseIdOf(msgObj: Record<string, unknown>): string | null {
  const id = (msgObj as { parent_tool_use_id?: string | null }).parent_tool_use_id
  return typeof id === 'string' && id ? id : null
}

// ============================================================
// System prompt building
// ============================================================

function buildFullSystemPrompt(
  contextPrompt: string,
  contextId: string | null,
  activeContextId?: string,
  planModeEnabled = false,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  powerfulMode = false,
): string {
  let fullSystemPrompt = SYSTEM_PROMPT + contextPrompt

  // Conversation history (passed by renderer when starting a NEW SDK session
  // — Plan Mode toggle closes the session, restored conversations also reset
  // it). Re-injecting the prior messages keeps the model coherent across
  // session boundaries.
  if (conversationHistory && conversationHistory.length > 0) {
    fullSystemPrompt += `

## HISTORIAL DE LA CONVERSACION ACTUAL

Esta sesion del SDK acaba de iniciarse pero la conversacion con el usuario ya tiene contexto previo. Estos son los mensajes anteriores entre el usuario y vos (el agente). Usalos como contexto para continuar coherente:

`
    for (const msg of conversationHistory) {
      const speaker = msg.role === 'user' ? '**Usuario**' : '**Agente (vos)**'
      // Cap each message to keep the prompt bounded — long pasted budget
      // tables don't help, we just need the gist.
      const content = msg.content.length > 4000
        ? msg.content.slice(0, 4000) + '\n\n[...mensaje truncado...]'
        : msg.content
      fullSystemPrompt += `\n${speaker}:\n${content}\n\n---\n`
    }
    fullSystemPrompt += `
Continua la conversacion respondiendo al ULTIMO mensaje del usuario teniendo en cuenta TODO lo que paso antes. Si el usuario dice algo como "confirmo" o "si" o "dale", interpretalo en el contexto del plan / pregunta inmediatamente anterior — NO le digas "no tengo contexto".
`
  }


  // Plan Mode directive — injected when the user toggles "Plan Mode" in the UI.
  // We don't use the SDK's permissionMode:'plan' because that auto-injects
  // ExitPlanMode which conflicts with our ask_user_question flow.
  if (planModeEnabled) {
    fullSystemPrompt += `

## ESTADO ACTUAL — PLAN MODE ACTIVADO POR EL USUARIO

El usuario ha activado **Plan Mode** desde la UI. En este turno y los proximos hasta que el usuario lo desactive, debes cumplir ESTRICTAMENTE estas reglas:

1. **NO ejecutes ninguna tool de escritura en CERP**. Eso incluye: \`create_project\`, \`create_budget\`, \`add_budget_chapter\`, \`add_budget_item\`, \`add_budget_items_batch\`, \`update_cost_items\`, \`update_budget_taxes\`, \`approve_budget\`, \`create_material\`, \`create_item\`, \`update_catalog_item\`, \`create_resource\`, \`update_resource\`, \`create_contact\`, \`update_contact\`, y cualquier otra que cree/modifique/borre datos en CERP. Si el usuario te pide ejecutar, respondele que tiene que **desactivar Plan Mode** primero desde el toggle de la UI (esta al lado del boton Enviar).

2. **NO uses \`ExitPlanMode\`**. Esa tool del SDK no existe para nosotros. El control de aprobar/rechazar el plan lo hace el usuario manualmente con el toggle de Plan Mode en la UI. Si crees que terminaste de planificar, simplemente: (a) invoca \`ask_user_question\` para confirmar lo que falte aclarar (paso 1b del prompt), (b) DESPUES de recibir respuestas, muestra el plan completo formateado (paso 1c), (c) termina el mensaje con "¿Confirmas la carga? Desactiva Plan Mode y respondeme para que arranque."

3. **SI podes ejecutar** tools de **lectura, busqueda y analisis**: \`Read\`, \`Glob\`, \`Grep\`, \`Bash\` (solo lectura), \`mcp__cerp__search_*\`, \`mcp__cerp__get_*\`, \`mcp__cerp__list_*\`, \`mcp__cerp__ask_user_question\`, y la delegacion a subagentes con \`Agent\`. Usalas todas las que necesites para investigar y construir el plan.

4. **NUNCA inventes** que ejecutaste algo. Si en este modo el usuario te pide "creá X", respondele: "Estamos en Plan Mode. Voy a planificar la creacion de X y te muestro el plan. Cuando confirmes, desactivas el toggle y arranco."

Estas reglas TIENEN PRIORIDAD sobre cualquier instruccion contraria en el resto del system prompt.
`
  } else if (conversationHistory && conversationHistory.length > 0) {
    // Apagar el toggle cierra la sesion y la siguiente arranca con el historial,
    // donde el propio agente escribio "estamos en Plan Mode". Sin este aviso lo
    // seguia creyendo activo y le pedia al usuario que confirmara el toggle.
    fullSystemPrompt += `

## ESTADO ACTUAL — PLAN MODE DESACTIVADO

Plan Mode esta **desactivado** en este momento, aunque el historial diga lo contrario. Podes ejecutar las escrituras que el usuario ya confirmo, sin volver a preguntarle por el toggle.
`
  }


  // Modo Potente — directiva de ejecución exhaustiva para cotizaciones complejas.
  // Absorbe lo que antes era el Modo Turbo (pill separada, eliminada): el usuario ya
  // no lo "activa" con un toggle aparte, lo obtiene eligiendo "Potente" en el selector
  // de modelo del composer.
  if (powerfulMode) {
    fullSystemPrompt += `

## MODO POTENTE ACTIVO — Cotización exhaustiva

El usuario seleccionó el modelo **Potente** para esta cotización compleja. Trabajás con máximo rigor:

1. **Planificá ANTES de escribir.** Mapeá el árbol completo capítulo → ítem → APU del pliego/mediciones antes de crear nada en CERP. No empieces a crear chapters sueltos sin saber qué ítems va a tener cada uno.
2. **Repartí el trabajo en subagentes.** Para licitaciones grandes, delegá la construcción de capítulos/APUs en subagentes especialistas (tool Agent) y coordiná; no intentes todo en un solo hilo lineal.
3. **Auto-verificá contra el CONTRATO DE COMPLETITUD (abajo) antes de cerrar.** No declares terminada la cotización hasta que CADA capítulo tenga al menos un ítem real y CADA ítem tenga su APU con cantidades y precios. Si algo quedó vacío, completalo o avisá explícitamente qué falta — NUNCA entregues capítulos vacíos.
4. El modo Potente tarda más y consume más recursos: está bien tomarte el tiempo, pero mantené al usuario informado del avance (no quedes en silencio largo).
`
  }

  const customAgentDefs = customAgentStore.getAgents()
  if (customAgentDefs.length > 0) {
    fullSystemPrompt += '\n\n## Agentes personalizados del usuario\n'
    for (const a of customAgentDefs) {
      fullSystemPrompt += `- **${a.name}**: ${a.description}\n`
    }
    fullSystemPrompt += '\nPuedes delegar tareas a estos agentes de la misma forma que a los especializados.\n'
  }

  const allContexts = customAgentStore.getContexts()
  if (allContexts.length > 0) {
    fullSystemPrompt += '\n\n## Contextos personalizados del usuario\n'
    fullSystemPrompt += 'El usuario ha creado estos contextos (instrucciones adicionales que se activan desde la interfaz):\n'
    for (const c of allContexts) {
      const isActive = c.id === (activeContextId || contextId)
      fullSystemPrompt += `- **${c.name}** ${isActive ? '(ACTIVO)' : '(inactivo)'}\n`
    }
    fullSystemPrompt += '\nSi el usuario pregunta por sus contextos, listale los que tiene.\n'
  }

  const ctxId = activeContextId || contextId
  if (ctxId) {
    const ctx = allContexts.find((c) => c.id === ctxId)
    if (ctx) {
      fullSystemPrompt += `\n\n## Contexto activo: ${ctx.name}\n${ctx.instructions}\n`
    }
  }

  return fullSystemPrompt
}

let cachedContextPrompt: string | null = null
// Empresa con la que se armó `cachedContextPrompt`. Multi-empresa (DK-1.1): el
// contexto (razón social, NIF, dirección, moneda) es de UNA empresa; si la empresa
// por defecto cambió, el cacheado no se reusa aunque nadie lo haya tirado, y uno
// armado mientras la empresa cambiaba no queda como válido para la nueva.
let cachedContextCompanyId: string | null = null

async function buildContextPrompt(httpClient: HttpClient): Promise<string> {
  const companyId = getCompanyId()
  if (cachedContextPrompt && cachedContextCompanyId === companyId) return cachedContextPrompt

  let context = '\n\n## Contexto de la empresa y usuario actual\n'

  try {
    const settings = await httpClient.get<any>('/companies/settings')
    const s = settings?.data?.settings || settings?.settings || settings?.data || settings

    if (s) {
      const biz = s.businessInfo || {}
      const addr = s.address || {}
      const regional = s.regional || {}

      context += `\n### Empresa\n`
      if (biz.legalName) context += `- Razon social: ${biz.legalName}\n`
      if (biz.commercialName) context += `- Nombre comercial: ${biz.commercialName}\n`
      if (biz.taxId) context += `- CUIT/NIF: ${biz.taxId}\n`
      if (biz.industry) context += `- Industria: ${biz.industry}\n`
      if (biz.phone) context += `- Telefono: ${biz.phone}\n`
      if (biz.website) context += `- Web: ${biz.website}\n`

      if (addr.street || addr.city) {
        context += `- Direccion: ${[addr.street, addr.city, addr.state, addr.postalCode, addr.country].filter(Boolean).join(', ')}\n`
      }

      context += `\n### Configuracion regional\n`
      if (regional.currency) context += `- Moneda: ${regional.currency}\n`
      if (regional.locale) context += `- Locale: ${regional.locale}\n`
      if (regional.timezone) context += `- Zona horaria: ${regional.timezone}\n`
      if (regional.dateFormat) context += `- Formato fecha: ${regional.dateFormat}\n`
      if (regional.numberFormat) {
        const nf = regional.numberFormat
        context += `- Separador decimal: "${nf.decimalSeparator}" | Miles: "${nf.thousandsSeparator}" | Decimales: ${nf.decimalPlaces}\n`
      }
    }

    logger.info('Company context loaded for system prompt')
  } catch (err) {
    logger.warn(`Could not load company settings: ${err}`)
    context += '(No se pudieron cargar los datos de la empresa)\n'
  }

  try {
    const userRes = await httpClient.get<any>('/users/me')
    const user = userRes?.data || userRes

    if (user) {
      context += `\n### Usuario actual\n`
      if (user.name) context += `- Nombre: ${user.name}\n`
      if (user.email) context += `- Email: ${user.email}\n`
      if (user.roles?.length) context += `- Roles: ${user.roles.join(', ')}\n`
      if (user.phone) context += `- Telefono: ${user.phone}\n`
    }
  } catch (err) {
    logger.warn(`Could not load user info: ${err}`)
  }

  context += `\nUsa estos datos cuando generes reportes, documentos o necesites informacion de la empresa. Formatea montos segun la moneda y formato regional configurado.\n`

  cachedContextPrompt = context
  cachedContextCompanyId = companyId
  return context
}

export function resetContextCache(): void {
  cachedContextPrompt = null
}

// ============================================================
// Message mapping
// ============================================================

/** Extract a short input summary string from a tool_use block's input object. */
function extractInputStr(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  if (input.command) return String(input.command).substring(0, 200)
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.prompt) return String(input.prompt).substring(0, 150)
  if (input.description) return String(input.description).substring(0, 150)
  return JSON.stringify(input).substring(0, 200)
}

/** Extract a short output string from a tool_result block's `content` (string or block array). */
function extractToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content.substring(0, 800)
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('').substring(0, 800)
  }
  return ''
}

function mapMessage(msg: Record<string, unknown>, activeDelegations: Map<string, string>, session?: AgentSession): AgentStreamEvent | AgentStreamEvent[] | null {
  const type = msg.type as string
  const subtype = msg.subtype as string | undefined

  // Streaming raw event (Ola 2 — token a token). Only messages with
  // parent_tool_use_id === null reach here: subagent stream_events are
  // intercepted earlier in processStreamLoop (parentToolUseId branch, which
  // `continue`s past mapMessage entirely) — so this is always the top-level
  // assistant's own stream, never a delegated subagent's.
  if (type === 'stream_event') {
    const event = msg.event as { type?: string; index?: number; delta?: { type?: string; text?: string } } | undefined
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      return { type: 'text_delta', text: event.delta.text, index: event.index ?? 0 }
    }
    return null
  }

  // Assistant message with text and/or tool_use blocks
  if (type === 'assistant') {
    const content = msg.message as { content?: Array<{ type: string; id?: string; text?: string; name?: string; input?: unknown }> }
    if (content?.content) {
      const events: AgentStreamEvent[] = []
      for (const block of content.content) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'text', text: block.text })
        }
        if (block.type === 'tool_use' && block.name && block.id) {
          const input = block.input as Record<string, unknown> | undefined
          const inputStr = extractInputStr(input)
          const toolUseId = block.id as string
          // Every tool_start carries its tool_use id. The renderer keys the
          // ToolExecution by it and marks it done when the matching tool_result arrives.
          events.push({ type: 'tool_start', toolUseId, name: block.name, input: inputStr })
          // Agent (was 'Task' before Claude Code v2.1.63) — register the delegation so
          // the subagent's inner events resolve the agent name, and emit agent_delegation.
          if (block.name === 'Agent' || block.name === 'Task') {
            const agentName = String(input?.agent_name || input?.name || input?.subagent_type || '').trim()
            const task = String(input?.prompt || input?.description || '').substring(0, 150)
            activeDelegations.set(toolUseId, agentName || 'agente')
            logger.debug(`Delegation registered: ${toolUseId} → ${agentName || 'agente'}`)
            if (agentName) {
              events.push({ type: 'agent_delegation', toolUseId, agentName, task })
            }
          }
        }
      }
      return events.length ? events : null
    }
  }

  // Tool results from the orchestrator's own tools arrive as `type:'user'` messages
  // whose content blocks are `{ type:'tool_result', tool_use_id, content, is_error }`.
  // (There is NO top-level `type:'tool_result'` message in the SDK 0.3.x stream.)
  // Key the done event by tool_use_id so it matches the right tool_start regardless of name.
  if (type === 'user') {
    const message = msg.message as { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } | undefined
    const events: AgentStreamEvent[] = []
    for (const block of message?.content ?? []) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        activeDelegations.delete(block.tool_use_id) // no-op unless it was an Agent delegation
        events.push({
          type: 'tool_done',
          toolUseId: block.tool_use_id,
          output: extractToolResultOutput(block.content),
          isError: block.is_error,
        })
      }
    }
    return events.length ? events : null
  }

  // Prompt suggestions
  if (type === 'prompt_suggestion') {
    const suggestions = (msg as any).suggestions as string[] | undefined
    const suggestion = (msg as any).suggestion as string | undefined
    const list = suggestions || (suggestion ? [suggestion] : [])
    if (list.length > 0) {
      return { type: 'prompt_suggestions', suggestions: list }
    }
  }

  // System status and task events
  if (type === 'system') {
    if (subtype === 'status') {
      return { type: 'status', message: (msg.message as string) || '' }
    }
    if (subtype === 'task_started') {
      const taskName = (msg as any).task_name || (msg as any).name || ''
      return { type: 'status', message: `Iniciando tarea: ${taskName}` }
    }
    if (subtype === 'task_progress') {
      // Keep the UI aware that work is happening
      return { type: 'status', message: '' }
    }
  }

  // Result (turn complete)
  if (type === 'result') {
    const cost = (msg as any).total_cost_usd as number | undefined
    const turns = (msg as any).num_turns as number | undefined
    const usage = (msg as any).usage || {}
    const inputTokens = usage.input_tokens || 0
    const outputTokens = usage.output_tokens || 0
    const cacheCreation = usage.cache_creation_input_tokens || 0
    const cacheRead = usage.cache_read_input_tokens || 0

    // total_cost_usd / num_turns vienen ACUMULADOS por sesión SDK — al backend se
    // reporta solo el DELTA de esta ejecución. Si el acumulado retrocede (sesión
    // nueva reusando el objeto), el valor entero es el delta.
    let costDelta = cost ?? 0
    let turnsDelta = turns ?? 0
    if (session) {
      if (typeof cost === 'number') {
        costDelta = cost >= session.lastReportedCostUsd ? cost - session.lastReportedCostUsd : cost
        session.lastReportedCostUsd = cost
      }
      if (typeof turns === 'number') {
        turnsDelta = turns >= session.lastReportedTurns ? turns - session.lastReportedTurns : turns
        session.lastReportedTurns = turns
      }
    }

    logger.info(`[USAGE] cost=$${cost?.toFixed(4) || '?'} (delta=$${costDelta.toFixed(4)}) | turns=${turns} | input=${inputTokens} | output=${outputTokens} | cache_create=${cacheCreation} | cache_read=${cacheRead}`)

    // Persistir el consumo de esta ejecución (fire-and-forget; no bloquea el stream).
    // Los result vacíos de reconexión (0 tokens y delta 0) son ruido: no se reportan.
    const hasTokens = inputTokens + outputTokens + cacheCreation + cacheRead > 0
    if (hasTokens || costDelta > 0) {
      reportExecutionUsage({
        inputTokens,
        outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        costUsd: costDelta,
        turns: turnsDelta,
        // Campo heredado del antiguo Modo Turbo (nombre sin cambios por contrato con el
        // backend) — ahora refleja si ESTA sesión corrió en modo "Potente" (Opus + xhigh).
        turbo: session?.powerful ?? false,
        quoteId: session ? getActiveQuoteId(session.conversationId) : undefined,
      })
    }
    // El evento al renderer conserva el costo ACUMULADO (footer de costo de la sesión).
    return { type: 'done', cost, turns, tokensIn: inputTokens, tokensOut: outputTokens }
  }

  return null
}
