import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createCerpMcpServer } from './mcpServer'
import { setAskUserWindow, cancelPendingQuestion } from './askUserBridge'
import { getCompanyId, getUserId, fetchApiKey } from '../auth/apiKeyManager'
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
// Persistent Streaming Session
// ============================================================
let activeQuery: any = null
let messageQueue: MessageQueue | null = null
let sessionCwd: string | null = null
let sessionContextId: string | null = null
let mainWindowRef: BrowserWindow | null = null
let processingTurn = false

// Active delegation registry: Agent/Task tool_use_id → agentName
// Populated when the orchestrator emits an Agent tool_use block; used to
// attach a human-readable label to every inner event the subagent emits
// (which carry parent_tool_use_id = that tool_use_id).
const activeDelegations = new Map<string, string>()

// Plan Mode — when true the agent uses permissionMode:'plan' and cannot execute
// write operations. The user reviews the plan and resumes in normal mode.
let planModeEnabled = false

export function getPlanMode(): boolean {
  return planModeEnabled
}

/**
 * Enable or disable Plan Mode.
 * If a session is already open, close it so the next runAgent call applies the new mode.
 */
export function setPlanMode(enabled: boolean): void {
  if (planModeEnabled === enabled) return
  planModeEnabled = enabled
  logger.info(`Plan Mode ${enabled ? 'enabled' : 'disabled'}`)
  // Close the current session — the next message will start a fresh one with the updated mode
  if (activeQuery) {
    closeSession()
  }
}

export function isAgentRunning(): boolean {
  return processingTurn
}

export function hasActiveSession(): boolean {
  return activeQuery !== null
}

/**
 * Interrupt current turn gracefully (agent can finish current thought)
 */
export async function interruptAgent(): Promise<void> {
  if (activeQuery) {
    try {
      await activeQuery.interrupt()
      logger.info('Agent interrupted')
    } catch (err) {
      logger.warn(`Interrupt failed, closing session: ${err}`)
      closeSession()
    }
  }
}

/**
 * Close the session entirely and clean up
 */
export function closeSession(): void {
  // Cancel any pending ask_user_question so the MCP promise doesn't hang
  cancelPendingQuestion()
  if (messageQueue) {
    messageQueue.close()
    messageQueue = null
  }
  if (activeQuery) {
    try {
      activeQuery.close()
    } catch { /* ignore */ }
    activeQuery = null
  }
  sessionCwd = null
  sessionContextId = null
  processingTurn = false
  cachedContextPrompt = null
  activeDelegations.clear()
  setAskUserWindow(null)
  logger.info('Session closed')
}

// Alias for IPC compatibility
export function resetSession(): void {
  closeSession()
}

export function abortAgent(): void {
  interruptAgent()
}

/**
 * Send a message to the agent. Starts a new session if needed.
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
  const cwd = payload.cwd || app.getPath('home')
  const contextId = payload.activeContextId || null

  // If session exists but cwd or context changed, close and restart
  if (activeQuery && (cwd !== sessionCwd || contextId !== sessionContextId)) {
    logger.info('Session options changed, closing current session')
    closeSession()
  }

  if (!activeQuery) {
    await startSession(payload, apiKey, model, httpClient, mainWindow, cwd, contextId)
  } else {
    // Send follow-up message to existing session
    sendFollowUp(payload.prompt)
  }
}

// ============================================================
// Session lifecycle
// ============================================================

async function startSession(
  payload: SendPromptPayload,
  apiKey: string,
  model: string,
  httpClient: HttpClient,
  mainWindow: BrowserWindow,
  cwd: string,
  contextId: string | null,
): Promise<void> {
  sessionCwd = cwd
  sessionContextId = contextId

  // Get companyId + userId
  let companyId = getCompanyId()
  let userId = getUserId()
  if (!companyId || !userId) {
    try {
      const config = await fetchApiKey(httpClient)
      companyId = config.companyId || null
      userId = config.userId || null
    } catch (err) {
      logger.warn(`Could not fetch config: ${err}`)
    }
  }
  logger.info(`CompanyId: ${companyId}, UserId: ${userId}`)

  const cerpMcpServer = createCerpMcpServer(httpClient, companyId, userId)
  const contextPrompt = await buildContextPrompt(httpClient)
  const fullSystemPrompt = buildFullSystemPrompt(
    contextPrompt,
    contextId,
    payload.activeContextId,
    planModeEnabled,
    payload.conversationHistory,
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
  // NOTE: linux-musl variants are not distinguished here (glibc assumed) — follow-up if we ship musl.
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const sdkCliPath = join(
    __dirname, '..', '..', 'node_modules', '@anthropic-ai', platformPkg, binName,
  ).replace('app.asar', 'app.asar.unpacked')

  logger.info(`SDK native binary path: ${sdkCliPath} (exists: ${require('fs').existsSync(sdkCliPath)})`)
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
    allowedTools: ['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__cerp__*', 'mcp__cerp__ask_user_question'],
    // NOTE: we never use permissionMode:'plan' because the SDK then auto-injects
    // the ExitPlanMode tool, which conflicts with our ask_user_question flow.
    // Instead, when planModeEnabled is true we inject a strict directive into
    // the system prompt that forbids write tools and ExitPlanMode (see
    // buildFullSystemPrompt). The user controls the toggle from the UI.
    permissionMode: 'bypassPermissions',
    maxTurns: payload.maxTurns ?? 100,
    maxBudgetUsd: payload.maxBudgetUsd ?? 10.0,
    includePartialMessages: true,
    promptSuggestions: true,
    // 'medium' keeps the agent responsive: 'high' triggers long extended-reasoning
    // pauses with no visible output, which reads as "frozen" in a live desktop UI.
    effort: 'medium',
    // Fase 2: forward subagent text/reasoning deltas so we can render them
    // inside the delegation card in real-time. Requires SDK >= 0.2.119.
    // When true, assistant messages from subagents (parent_tool_use_id set)
    // include full text blocks, not just tool_use/tool_result heartbeats.
    forwardSubagentText: true,
  }

  logger.info(`Starting session: "${payload.prompt.slice(0, 80)}..." (cwd: ${cwd}, planMode: ${planModeEnabled})`)

  // Create persistent message queue — keeps the session alive between turns
  messageQueue = new MessageQueue()
  messageQueue.push(payload.prompt)

  activeQuery = query({
    prompt: messageQueue as any,
    options: options as any,
  })

  // Process stream in background
  processStreamLoop()
}

function sendFollowUp(prompt: string): void {
  if (!messageQueue) {
    logger.error('No active message queue — cannot send follow-up')
    return
  }
  logger.info(`Sending follow-up: "${prompt.slice(0, 80)}..."`)
  messageQueue.push(prompt)
}

// ============================================================
// Stream processing (runs in background)
// ============================================================

async function processStreamLoop(): Promise<void> {
  if (!activeQuery || !mainWindowRef) return

  const sendEvent = (event: AgentStreamEvent): void => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, event)
    }
  }

  const sendDone = (): void => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, {})
    }
  }

  let activeTaskCount = 0

  // Heartbeat: keep the renderer's "IA activa" badge alive during long SILENT gaps.
  // The for-await loop BLOCKS while awaiting the next SDK message, so during a multi-minute
  // pause (e.g. a background subagent generating with no parent stream_events) nothing is
  // forwarded and the renderer's safety timer would flip the badge to inactive even though
  // the agent is actively working. A standalone interval forwards a lightweight stream_start
  // every 5s WHILE actively processing — a background task is running (`activeTaskCount > 0`)
  // OR a turn is in progress (`processingTurn`). It stops emitting on its own once the turn
  // completes (processingTurn=false, activeTaskCount=0) and is cleared in `finally`.
  const heartbeat = setInterval(() => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return
    if (activeTaskCount > 0 || processingTurn) {
      sendEvent({ type: 'stream_start' })
    }
  }, 5000)

  try {
    for await (const msg of activeQuery) {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) break

      const msgObj = msg as Record<string, unknown>
      const msgType = msgObj.type as string
      const msgSubtype = msgObj.subtype as string | undefined

      logger.debug(`Stream: type=${msgType} subtype=${msgSubtype || '-'} tasks=${activeTaskCount}`)

      // Track background tasks and system events
      if (msgType === 'system') {
        if (msgSubtype === 'task_started') {
          activeTaskCount++
          processingTurn = true
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
        processingTurn = true
      }

      // ── Subagent inner activity routing ──────────────────────────────────
      // Messages from inside a subagent carry parent_tool_use_id = the Agent
      // tool_use_id that spawned them. We route these to dedicated subagent
      // events instead of discarding them.
      const parentToolUseId = (msgObj as any).parent_tool_use_id as string | null | undefined
      if (parentToolUseId) {
        const agentName = activeDelegations.get(parentToolUseId) ?? 'agente'

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
      const events = mapMessage(msgObj)
      if (events) {
        const arr = Array.isArray(events) ? events : [events]
        for (const event of arr) {
          if (event.type === 'done') {
            logger.info(`Turn complete (cost=$${(event as any).cost?.toFixed(4) || '?'}, tasks=${activeTaskCount})`)
            if (activeTaskCount > 0) {
              // Background tasks still running — don't signal done to UI yet
              logger.info(`Holding done: ${activeTaskCount} tasks still active`)
              continue
            }
            // Turn complete and no background tasks — unlock UI for next input
            // Session stays alive (MessageQueue keeps the query running)
            sendEvent(event)
            sendDone()
            processingTurn = false
            continue
          }
          sendEvent(event)
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (message.includes('aborted') || message.includes('interrupt')) {
      logger.info('Session interrupted/aborted')
      sendEvent({ type: 'done' })
    } else {
      logger.error(`Stream error: ${message}`)
      sendEvent({ type: 'error', message })
    }
    sendDone()
  } finally {
    clearInterval(heartbeat)
    processingTurn = false
    activeQuery = null
    // Always ensure UI resets — covers budget exceeded, errors, etc.
    sendEvent({ type: 'done' })
    sendDone()
    logger.info('Stream loop ended')
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

function mapMessage(msg: Record<string, unknown>): AgentStreamEvent | AgentStreamEvent[] | null {
  const type = msg.type as string
  const subtype = msg.subtype as string | undefined

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
    logger.info(`[USAGE] cost=$${cost?.toFixed(4) || '?'} | turns=${turns} | input=${inputTokens} | output=${outputTokens} | cache_create=${cacheCreation} | cache_read=${cacheRead}`)
    return { type: 'done', cost, turns, tokensIn: inputTokens, tokensOut: outputTokens }
  }

  return null
}
