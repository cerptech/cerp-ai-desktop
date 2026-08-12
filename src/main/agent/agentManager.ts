import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createCerpMcpServer } from './mcpServer'
import { setAskUserWindow, cancelPendingQuestion } from './askUserBridge'
import { stopQuoteHeartbeat } from './quoteHeartbeat'
import { setQuoteEventWindow } from './quoteEventsBridge'
import { setHtmlCanvasWindow, clearCanvases } from './htmlCanvasBridge'
import { initUsageReporter, reportExecutionUsage } from './usageReporter'
import { getCompanyId, getUserId, fetchApiKey, getMaxBudgetUsd, getMaxBudgetUsdTurbo, NoCreditsError } from '../auth/apiKeyManager'
import { SYSTEM_PROMPT } from './systemPrompt'
import { CONSTRUCTION_AGENTS } from './agents'
import { customAgentStore } from '../store/customAgentStore'
import { HttpClient } from '../utils/httpClient'
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
}

const sessions = new Map<string, AgentSession>()
let mainWindowRef: BrowserWindow | null = null

// Conversaciones que arrancan antes de tener id real (legacy / primer mensaje)
// usan esta clave efímera.
const DEFAULT_CONV = '__default__'

// Plan Mode — global (es un toggle de UI, no por-conversación). When true the
// agent cannot execute write operations; the user reviews the plan and resumes.
let planModeEnabled = false

// Turbo Mode (Idea 3, MVP conservador) — when true, complex quotes run with the
// Opus xhigh-capable model + effort 'xhigh' + the Workflow tool / dynamic-workflow
// orchestration. Opt-in (off by default): xhigh worsens the silent-pause "frozen UI"
// effect and costs more, so it's only for big licitaciones, not chat. NOT ultracode
// (that's the gated Full path — needs the prod account's Workflows entitlement).
let turboModeEnabled = false

// xhigh-capable Opus model used when Turbo is ON. Pinning a known xhigh-capable
// model avoids the SDK's silent xhigh→high downgrade (which only happens on
// non-capable models). If the prod key lacks Opus access, the query fails loudly.
const TURBO_MODEL = 'claude-opus-4-8'

export function getPlanMode(): boolean {
  return planModeEnabled
}

export function getTurboMode(): boolean {
  return turboModeEnabled
}

/**
 * Enable or disable Turbo Mode. Like Plan Mode, the active session is closed so the
 * next runAgent applies the new model/effort/tools (Turbo settings are baked into
 * the SDK query options at startSession and don't change mid-session).
 */
export function setTurboMode(enabled: boolean): void {
  if (turboModeEnabled === enabled) return
  turboModeEnabled = enabled
  logger.info(`Turbo Mode ${enabled ? 'enabled' : 'disabled'}`)
  // Turbo es global (como Plan Mode): cerramos TODAS las sesiones para que el
  // próximo mensaje de cada conversación arranque con el modelo/effort/tools nuevos.
  for (const id of [...sessions.keys()]) closeSession(id)
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
  for (const id of [...sessions.keys()]) closeSession(id)
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
 */
export function closeSession(conversationId: string = DEFAULT_CONV): void {
  const session = sessions.get(conversationId)
  if (!session) return
  // Cancel any pending ask_user_question for THIS conversation so the MCP promise doesn't hang
  cancelPendingQuestion(conversationId)
  // Stop the credit reservation heartbeat — if a quote was mid-flight, the backend
  // watchdog will refund it on heartbeat timeout (no credit lost to an aborted run).
  stopQuoteHeartbeat()
  try { session.messageQueue.close() } catch { /* ignore */ }
  try { session.query.close() } catch { /* ignore */ }
  if (session.heartbeat) clearInterval(session.heartbeat)
  session.activeDelegations.clear()
  sessions.delete(conversationId)
  logger.info(`Session closed (${conversationId})`)
}

/** Close every active session (logout / global reset). */
export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id)
  cachedContextPrompt = null
  setAskUserWindow(null)
  setHtmlCanvasWindow(null)
  clearCanvases()
  logger.info('All sessions closed')
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
  const conversationId = payload.conversationId || DEFAULT_CONV
  const cwd = payload.cwd || app.getPath('home')
  const contextId = payload.activeContextId || null

  let session = sessions.get(conversationId)

  // If THIS conversation's session exists but cwd/context/model changed, restart only
  // it. Other conversations' sessions are untouched — that's the point of concurrency.
  if (session && (cwd !== session.cwd || contextId !== session.contextId || model !== session.model)) {
    logger.info(`Session options changed, restarting session (${conversationId})`)
    closeSession(conversationId)
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
    try {
      const config = await fetchApiKey(httpClient)
      companyId = config.companyId || null
      userId = config.userId || null
    } catch (err) {
      // Paywall (Modelo CERP): la empresa se quedó sin créditos entre el gate de
      // handlers.ts y el arranque de esta sesión (p.ej. companyId/userId no estaban
      // cacheados todavía). A diferencia de un fallo de red/config, esto NO es
      // recuperable con datos parciales — cortamos acá con un evento distinguible
      // en vez de arrancar una sesión rota.
      if (err instanceof NoCreditsError) {
        logger.warn(`startSession aborted (${conversationId}): no credits available`)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, {
            conversationId,
            event: { type: 'error', message: err.message, code: 'NO_CREDITS' },
          })
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, { conversationId })
        }
        return
      }
      logger.warn(`Could not fetch config: ${err}`)
    }
  }
  logger.info(`CompanyId: ${companyId}, UserId: ${userId}`)

  // Turbo Mode (Idea 3 MVP): raise execution rigor for complex quotes. Pin the
  // xhigh-capable Opus model + xhigh effort + the Workflow tool. Off by default.
  const turbo = turboModeEnabled
  const effectiveModel = turbo ? TURBO_MODEL : model
  const effort = turbo ? 'xhigh' : 'medium'
  if (turbo) {
    logger.info(`Turbo Mode ON — model=${effectiveModel}, effort=${effort}, workflows enabled`)
  }

  // Reporte de consumo de tokens por ejecución (rentabilidad por cliente).
  // Fija el cliente HTTP + el modelo efectivo + el contexto; mapMessage reporta en cada `result`.
  initUsageReporter(httpClient, effectiveModel, contextId)

  const cerpMcpServer = createCerpMcpServer(httpClient, companyId, userId, conversationId)
  const contextPrompt = await buildContextPrompt(httpClient)
  const fullSystemPrompt = buildFullSystemPrompt(
    contextPrompt,
    contextId,
    payload.activeContextId,
    planModeEnabled,
    payload.conversationHistory,
    turbo,
  )

  // Build subagent definitions (with model overrides for cost optimization)
  const builtInAgents = CONSTRUCTION_AGENTS.map((a) => ({
    name: a.name,
    description: a.description,
    instructions: a.prompt,
    ...(a.model && a.model !== 'inherit' ? { model: a.model } : {}),
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
    model: effectiveModel,
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
      // Turbo: habilita la orquestación de workflows dinámicos para cotizaciones grandes.
      ...(turbo ? ['Workflow'] : []),
    ],
    // Turbo: orquestación de workflows dinámicos (MVP conservador, sin ultracode).
    enableWorkflows: turbo,
    // NOTE: we never use permissionMode:'plan' because the SDK then auto-injects
    // the ExitPlanMode tool, which conflicts with our ask_user_question flow.
    // Instead, when planModeEnabled is true we inject a strict directive into
    // the system prompt that forbids write tools and ExitPlanMode (see
    // buildFullSystemPrompt). The user controls the toggle from the UI.
    permissionMode: 'bypassPermissions',
    maxTurns: payload.maxTurns ?? 100,
    // Turbo gasta más (Opus + xhigh + workflows): subimos el techo de forma consciente.
    // Prioridad: payload explícito > techo por plan (backend, Modelo CERP) > hardcode legacy.
    maxBudgetUsd: payload.maxBudgetUsd ?? (turbo ? (getMaxBudgetUsdTurbo() ?? 25.0) : (getMaxBudgetUsd() ?? 10.0)),
    includePartialMessages: true,
    promptSuggestions: true,
    // 'medium' keeps the agent responsive: 'high' triggers long extended-reasoning
    // pauses with no visible output, which reads as "frozen" in a live desktop UI.
    // Turbo opts INTO that trade-off ('xhigh') for complex quotes — the heartbeat
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
    processingTurn: false,
    activeDelegations: new Map(),
    heartbeat: null,
    lastReportedCostUsd: 0,
    lastReportedTurns: 0,
  }
  sessions.set(conversationId, session)

  // Process stream in background
  processStreamLoop(session)
}

function sendFollowUp(session: AgentSession, prompt: string): void {
  logger.info(`Sending follow-up (${session.conversationId}): "${prompt.slice(0, 80)}..."`)
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
  const sendEvent = (event: AgentStreamEvent): void => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, { conversationId, event })
    }
  }

  const sendDone = (): void => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, { conversationId })
    }
  }

  let activeTaskCount = 0

  // Heartbeat: keep the renderer's "IA activa" badge alive during long SILENT gaps.
  // The for-await loop BLOCKS while awaiting the next SDK message, so during a multi-minute
  // pause (e.g. a background subagent generating with no parent stream_events) nothing is
  // forwarded and the renderer's safety timer would flip the badge to inactive even though
  // the agent is actively working. A standalone interval forwards a lightweight stream_start
  // every 5s WHILE actively processing — a background task is running (`activeTaskCount > 0`)
  // OR a turn is in progress (`session.processingTurn`). It stops emitting on its own once the
  // turn completes and is cleared in `finally`.
  session.heartbeat = setInterval(() => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    if (activeTaskCount > 0 || session.processingTurn) {
      sendEvent({ type: 'stream_start' })
    }
  }, 5000)

  try {
    for await (const msg of session.query) {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) break

      const msgObj = msg as Record<string, unknown>
      const msgType = msgObj.type as string
      const msgSubtype = msgObj.subtype as string | undefined

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
          logger.info(`Background task completed (${activeTaskCount} remaining)`)
        } else if (msgSubtype === 'api_retry') {
          // SDK is retrying an API call — show feedback so UI doesn't look stuck
          sendEvent({ type: 'status', message: 'Reconectando con el servidor...' })
          logger.warn('API retry in progress')
        }
      }

      // Track turn state (the heartbeat interval handles keep-alive during silent gaps)
      if (msgType === 'assistant' || msgType === 'stream_event') {
        session.processingTurn = true
      }

      // ── Subagent inner activity routing ──────────────────────────────────
      // Messages from inside a subagent carry parent_tool_use_id = the Agent
      // tool_use_id that spawned them. We route these to dedicated subagent
      // events instead of discarding them.
      const parentToolUseId = (msgObj as any).parent_tool_use_id as string | null | undefined
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

      // Map and forward events
      const events = mapMessage(msgObj, session.activeDelegations, session)
      if (events) {
        const arr = Array.isArray(events) ? events : [events]
        for (const event of arr) {
          if (event.type === 'done') {
            logger.info(`Turn complete [${conversationId}] (cost=$${(event as any).cost?.toFixed(4) || '?'}, tasks=${activeTaskCount})`)
            if (activeTaskCount > 0) {
              // Background tasks still running — don't signal done to UI yet
              logger.info(`Holding done: ${activeTaskCount} tasks still active`)
              continue
            }
            // Turn complete and no background tasks — unlock UI for next input
            // Session stays alive (MessageQueue keeps the query running)
            sendEvent(event)
            sendDone()
            session.processingTurn = false
            continue
          }
          sendEvent(event)
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (message.includes('aborted') || message.includes('interrupt')) {
      logger.info(`Session interrupted/aborted (${conversationId})`)
      sendEvent({ type: 'done' })
    } else {
      logger.error(`Stream error (${conversationId}): ${message}`)
      sendEvent({ type: 'error', message })
    }
    sendDone()
  } finally {
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null }
    session.processingTurn = false
    // The for-await loop only ends when the message queue closes (closeSession) or the
    // stream errors — the session is truly over, so drop it from the registry.
    sessions.delete(conversationId)
    // Always ensure UI resets — covers budget exceeded, errors, etc.
    sendEvent({ type: 'done' })
    sendDone()
    logger.info(`Stream loop ended (${conversationId})`)
  }
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
  turboModeEnabled = false,
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

1. **NO ejecutes ninguna tool de escritura en CERP**. Eso incluye: \`create_project\`, \`create_budget\`, \`add_budget_chapter\`, \`add_budget_item\`, \`add_budget_items_batch\`, \`update_cost_items\`, \`approve_budget\`, \`create_material\`, \`update_material\`, \`create_resource\`, \`update_resource\`, \`create_contact\`, \`update_contact\`, y cualquier otra que cree/modifique/borre datos en CERP. Si el usuario te pide ejecutar, respondele que tiene que **desactivar Plan Mode** primero desde el toggle de la UI (esta al lado del boton Enviar).

2. **NO uses \`ExitPlanMode\`**. Esa tool del SDK no existe para nosotros. El control de aprobar/rechazar el plan lo hace el usuario manualmente con el toggle de Plan Mode en la UI. Si crees que terminaste de planificar, simplemente: (a) invoca \`ask_user_question\` para confirmar lo que falte aclarar (paso 1b del prompt), (b) DESPUES de recibir respuestas, muestra el plan completo formateado (paso 1c), (c) termina el mensaje con "¿Confirmas la carga? Desactiva Plan Mode y respondeme para que arranque."

3. **SI podes ejecutar** tools de **lectura, busqueda y analisis**: \`Read\`, \`Glob\`, \`Grep\`, \`Bash\` (solo lectura), \`mcp__cerp__search_*\`, \`mcp__cerp__get_*\`, \`mcp__cerp__list_*\`, \`mcp__cerp__ask_user_question\`, y la delegacion a subagentes con \`Agent\`. Usalas todas las que necesites para investigar y construir el plan.

4. **NUNCA inventes** que ejecutaste algo. Si en este modo el usuario te pide "creá X", respondele: "Estamos en Plan Mode. Voy a planificar la creacion de X y te muestro el plan. Cuando confirmes, desactivas el toggle y arranco."

Estas reglas TIENEN PRIORIDAD sobre cualquier instruccion contraria en el resto del system prompt.
`
  }


  // Turbo Mode (Idea 3) — directiva de ejecución exhaustiva para cotizaciones complejas.
  if (turboModeEnabled) {
    fullSystemPrompt += `

## MODO TURBO ACTIVADO — Cotización exhaustiva

El usuario activó **Modo Turbo** para esta cotización compleja. Trabajás con máximo rigor:

1. **Planificá ANTES de escribir.** Mapeá el árbol completo capítulo → ítem → APU del pliego/mediciones antes de crear nada en CERP. No empieces a crear chapters sueltos sin saber qué ítems va a tener cada uno.
2. **Repartí el trabajo en subagentes.** Para licitaciones grandes, delegá la construcción de capítulos/APUs en subagentes especialistas (tool Agent) y coordiná; no intentes todo en un solo hilo lineal.
3. **Auto-verificá contra el CONTRATO DE COMPLETITUD (abajo) antes de cerrar.** No declares terminada la cotización hasta que CADA capítulo tenga al menos un ítem real y CADA ítem tenga su APU con cantidades y precios. Si algo quedó vacío, completalo o avisá explícitamente qué falta — NUNCA entregues capítulos vacíos.
4. Turbo tarda más y consume más recursos: está bien tomarte el tiempo, pero mantené al usuario informado del avance (no quedes en silencio largo).
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

async function buildContextPrompt(httpClient: HttpClient): Promise<string> {
  if (cachedContextPrompt) return cachedContextPrompt

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
        turbo: turboModeEnabled,
      })
    }
    // El evento al renderer conserva el costo ACUMULADO (footer de costo de la sesión).
    return { type: 'done', cost, turns, tokensIn: inputTokens, tokensOut: outputTokens }
  }

  return null
}
