import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { createCerpMcpServer } from './mcpServer'
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
  const fullSystemPrompt = buildFullSystemPrompt(contextPrompt, contextId, payload.activeContextId)

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

  const options: Record<string, unknown> = {
    model,
    systemPrompt: fullSystemPrompt,
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
    },
    mcpServers: {
      cerp: cerpMcpServer,
    },
    agents: [...builtInAgents, ...customSdkAgents],
    allowedTools: ['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__cerp__*'],
    permissionMode: 'bypassPermissions',
    maxTurns: payload.maxTurns ?? 100,
    maxBudgetUsd: payload.maxBudgetUsd ?? 10.0,
    includePartialMessages: true,
    promptSuggestions: true,
    effort: 'high',
  }

  logger.info(`Starting session: "${payload.prompt.slice(0, 80)}..." (cwd: ${cwd})`)

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

  try {
    for await (const msg of activeQuery) {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) break

      const msgObj = msg as Record<string, unknown>
      const msgType = msgObj.type as string
      const msgSubtype = msgObj.subtype as string | undefined

      logger.debug(`Stream: type=${msgType} subtype=${msgSubtype || '-'} tasks=${activeTaskCount}`)

      // Track background tasks (subagent delegation)
      if (msgType === 'system') {
        if (msgSubtype === 'task_started') {
          activeTaskCount++
          processingTurn = true
          logger.info(`Background task started (${activeTaskCount} active)`)
        } else if (msgSubtype === 'task_notification') {
          activeTaskCount = Math.max(0, activeTaskCount - 1)
          logger.info(`Background task completed (${activeTaskCount} remaining)`)
          if (activeTaskCount === 0) {
            // All background tasks done — the agent will continue with a final response
          }
        }
      }

      // Track turn state
      if (msgType === 'assistant' || msgType === 'stream_event') {
        processingTurn = true
      }

      // Skip subagent messages from rendering in the main chat
      // Messages from background tasks have parent_tool_use_id set
      const parentToolId = (msgObj as any).parent_tool_use_id
      if (parentToolId && (msgType === 'assistant' || msgType === 'tool_result' || msgType === 'user')) {
        continue // Don't forward subagent internals to UI
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

function buildFullSystemPrompt(contextPrompt: string, contextId: string | null, activeContextId?: string): string {
  let fullSystemPrompt = SYSTEM_PROMPT + contextPrompt

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

function mapMessage(msg: Record<string, unknown>): AgentStreamEvent | AgentStreamEvent[] | null {
  const type = msg.type as string
  const subtype = msg.subtype as string | undefined

  // Assistant message with text and/or tool_use blocks
  if (type === 'assistant') {
    const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }
    if (content?.content) {
      const events: AgentStreamEvent[] = []
      for (const block of content.content) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'text', text: block.text })
        }
        if (block.type === 'tool_use' && block.name) {
          const input = block.input as Record<string, unknown> | undefined
          let inputStr = ''
          if (input) {
            if (input.command) inputStr = String(input.command).substring(0, 200)
            else if (input.file_path) inputStr = String(input.file_path)
            else if (input.pattern) inputStr = String(input.pattern)
            else if (input.prompt) inputStr = String(input.prompt).substring(0, 150)
            else if (input.description) inputStr = String(input.description).substring(0, 150)
            else inputStr = JSON.stringify(input).substring(0, 200)
          }
          events.push({ type: 'tool_start', name: block.name, input: inputStr })

          if (block.name === 'Agent' && input) {
            const agentName = String(input.agent_name || input.name || input.subagent_type || '').trim()
            const task = String(input.prompt || input.description || '').substring(0, 150)
            if (agentName) {
              events.push({ type: 'agent_delegation', agentName, task })
            }
          }
        }
      }
      return events.length ? events : null
    }
  }

  // Tool result
  if (type === 'tool_result') {
    const name = (msg as any).name as string || 'tool'
    const content = (msg as any).content
    let output = ''
    if (typeof content === 'string') {
      output = content.substring(0, 800)
    } else if (Array.isArray(content)) {
      output = content.map((c: any) => c.text || '').join('').substring(0, 800)
    }
    return { type: 'tool_done', name, output }
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
    return { type: 'done', cost, turns }
  }

  return null
}
