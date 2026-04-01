import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createCerpMcpServer } from './mcpServer'
import { getCompanyId, getUserId, fetchApiKey } from '../auth/apiKeyManager'
import { SYSTEM_PROMPT } from './systemPrompt'
import { CONSTRUCTION_AGENTS } from './agents'
import { customAgentStore } from '../store/customAgentStore'
import { HttpClient } from '../utils/httpClient'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AgentStreamEvent } from '../ipc/types'

// Track running queries (support parallel)
const activeQueries = new Map<string, AbortController>()
let currentSessionId: string | null = null

// ============================================================
// Session ID disk persistence
// ============================================================
function getSessionFilePath(): string {
  return join(app.getPath('userData'), 'session.json')
}

function writeSessionToDisk(sessionId: string): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(getSessionFilePath(), JSON.stringify({ sessionId }, null, 2))
  } catch {
    // ignore write errors
  }
}

function loadSessionFromDisk(): string | null {
  try {
    const raw = readFileSync(getSessionFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed.sessionId as string) || null
  } catch {
    return null
  }
}

export function isAgentRunning(): boolean {
  return activeQueries.size > 0
}

export function abortAgent(queryId?: string): void {
  if (queryId) {
    const controller = activeQueries.get(queryId)
    if (controller) {
      controller.abort()
      activeQueries.delete(queryId)
      logger.info(`Agent ${queryId} aborted`)
    }
  } else {
    // Abort all
    for (const [id, controller] of activeQueries) {
      controller.abort()
      logger.info(`Agent ${id} aborted`)
    }
    activeQueries.clear()
  }
}

export function resetSession(): void {
  abortAgent()
  currentSessionId = null
  cachedContextPrompt = null
  try {
    unlinkSync(getSessionFilePath())
  } catch {
    // file may not exist — ignore
  }
  logger.info('Session reset')
}

export function getSessionId(): string | null {
  if (currentSessionId) return currentSessionId
  const fromDisk = loadSessionFromDisk()
  if (fromDisk) {
    currentSessionId = fromDisk
    logger.info(`Session ID restored from disk: ${currentSessionId}`)
  }
  return currentSessionId
}

export async function runAgent(
  payload: SendPromptPayload,
  apiKey: string,
  model: string,
  httpClient: HttpClient,
  mainWindow: BrowserWindow,
): Promise<void> {
  const queryId = `q-${Date.now()}`
  const abortController = new AbortController()
  activeQueries.set(queryId, abortController)

  // Get companyId + userId — re-fetch if not cached
  let companyId = getCompanyId()
  let userId = getUserId()
  if (!companyId || !userId) {
    try {
      const config = await fetchApiKey(httpClient)
      companyId = config.companyId || null
      userId = config.userId || null
    } catch (err) {
      logger.warn(`[${queryId}] Could not fetch config: ${err}`)
    }
  }
  logger.info(`[${queryId}] CompanyId: ${companyId}, UserId: ${userId}`)
  const cerpMcpServer = createCerpMcpServer(httpClient, companyId, userId)

  const sendEvent = (event: AgentStreamEvent): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, event)
    }
  }

  const sendDone = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, {})
    }
  }

  // Safety timeout — if the agent runs longer than 15 minutes, force stop
  const safetyTimeout = setTimeout(() => {
    if (activeQueries.has(queryId)) {
      logger.warn(`Agent ${queryId} hit safety timeout (15 min), aborting`)
      abortController.abort()
      activeQueries.delete(queryId)
      sendEvent({ type: 'error', message: 'La consulta excedio el tiempo maximo (15 min). Intenta dividir la tarea en pasos mas pequenos.' })
      sendDone()
    }
  }, 15 * 60 * 1000)

  // Helper to process stream messages (used by main flow and retry)
  const processStream = async (stream: AsyncIterable<unknown>, tag: string): Promise<boolean> => {
    let gotResult = false
    for await (const msg of stream) {
      if (abortController.signal.aborted) break
      const msgType = (msg as any).type
      const msgSubtype = (msg as any).subtype
      logger.debug(`[${queryId}] Stream msg${tag}: type=${msgType} subtype=${msgSubtype || '-'} keys=${Object.keys(msg as object).join(',')}`)

      // Capture session ID
      if (!currentSessionId) {
        const sid = (msg as any).sessionId || (msg as any).session_id || (msg as any).id
        if (sid && typeof sid === 'string') {
          currentSessionId = sid
          writeSessionToDisk(currentSessionId)
          sendEvent({ type: 'session_id', sessionId: currentSessionId })
          logger.info(`[${queryId}] Session ID captured${tag}: ${currentSessionId}`)
        }
      }
      if (msgType === 'result') {
        const resultSid = (msg as any).session_id || (msg as any).sessionId
        if (resultSid && typeof resultSid === 'string') {
          currentSessionId = resultSid
          writeSessionToDisk(currentSessionId)
          sendEvent({ type: 'session_id', sessionId: currentSessionId })
          logger.info(`[${queryId}] Session ID from result${tag}: ${currentSessionId}`)
        }
      }

      const events = mapMessage(msg as Record<string, unknown>)
      if (events) {
        const arr = Array.isArray(events) ? events : [events]
        for (const event of arr) {
          if (event.type === 'done') gotResult = true
          sendEvent(event)
        }
      }
    }
    return gotResult
  }

  try {
    const sessionId = payload.sessionId || currentSessionId
    const cwd = payload.cwd || app.getPath('home')

    logger.info(`[${queryId}] Running agent query: "${payload.prompt.slice(0, 80)}..." (session: ${sessionId || 'new'}, cwd: ${cwd})`)

    const startTime = Date.now()

    // Fetch company/user context for the system prompt (cached after first call)
    const contextPrompt = await buildContextPrompt(httpClient)

    // Build subagent definitions (built-in + custom)
    const builtInAgents = CONSTRUCTION_AGENTS.map((a) => ({
      name: a.name,
      description: a.description,
      instructions: a.prompt,
    }))
    const customAgentDefs = customAgentStore.getAgents()
    const customSdkAgents = customAgentDefs.map((a) => ({
      name: a.name,
      description: a.description,
      instructions: a.systemPrompt,
    }))
    const agents = [...builtInAgents, ...customSdkAgents]

    // Build dynamic system prompt with custom agents list + context instructions
    let fullSystemPrompt = SYSTEM_PROMPT + contextPrompt
    if (customSdkAgents.length > 0) {
      fullSystemPrompt += '\n\n## Agentes personalizados del usuario\n'
      for (const a of customAgentDefs) {
        fullSystemPrompt += `- **${a.name}**: ${a.description}\n`
      }
      fullSystemPrompt += '\nPuedes delegar tareas a estos agentes de la misma forma que a los especializados.\n'
    }
    if (payload.activeContextId) {
      const ctx = customAgentStore.getContexts().find((c) => c.id === payload.activeContextId)
      if (ctx) {
        fullSystemPrompt += `\n\n## Contexto adicional activo: ${ctx.name}\n${ctx.instructions}\n`
        logger.info(`[${queryId}] Active context: ${ctx.name} (${ctx.id})`)
      }
    }

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
      agents,
      allowedTools: ['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__cerp__*'],
      permissionMode: 'bypassPermissions',
      maxTurns: payload.maxTurns ?? 50,
      maxBudgetUsd: payload.maxBudgetUsd ?? 2.0,
      includePartialMessages: true,
      abortController,
    }

    // Resume existing session for conversation continuity
    if (sessionId) {
      (options as any).resume = sessionId
    }

    let receivedResult = false

    try {
      const q = query({ prompt: payload.prompt, options: options as any })
      receivedResult = await processStream(q, '')
    } catch (queryErr) {
      const qMsg = queryErr instanceof Error ? queryErr.message : String(queryErr)

      // If session resume failed, clear session and retry with a fresh one
      if (qMsg.includes('No conversation found with session ID')) {
        logger.warn(`[${queryId}] Session expired, retrying with fresh session`)
        currentSessionId = null
        try { unlinkSync(getSessionFilePath()) } catch { /* ignore */ }
        delete (options as any).resume
        const retryQ = query({ prompt: payload.prompt, options: options as any })
        receivedResult = await processStream(retryQ, ' (retry)')
      } else {
        throw queryErr // Re-throw for outer catch
      }
    }

    const duration = Date.now() - startTime
    if (!receivedResult) {
      sendEvent({ type: 'done', duration })
    }

    logger.info(`[${queryId}] Agent query completed in ${duration}ms`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (message.includes('aborted') || abortController.signal.aborted) {
      sendEvent({ type: 'done' })
      logger.info(`[${queryId}] Agent aborted`)
    } else {
      logger.error(`[${queryId}] Agent error: ${message}`)
      sendEvent({ type: 'error', message })
    }
  } finally {
    clearTimeout(safetyTimeout)
    activeQueries.delete(queryId)

    // Always send AGENT_STREAM_DONE to ensure UI resets
    sendDone()
    logger.info(`[${queryId}] Agent cleanup complete (${activeQueries.size} queries still active)`)
  }
}

// ============================================================
// Company/User context injection
// ============================================================
let cachedContextPrompt: string | null = null

async function buildContextPrompt(httpClient: HttpClient): Promise<string> {
  if (cachedContextPrompt) return cachedContextPrompt

  let context = '\n\n## Contexto de la empresa y usuario actual\n'

  try {
    // Fetch company settings
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
    // Fetch current user
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

          // Emit agent_delegation event when the Agent tool is used
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

  // System status
  if (type === 'system') {
    if (subtype === 'status') {
      return { type: 'status', message: (msg.message as string) || '' }
    }
  }

  // Result (query complete) — log full usage data
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
