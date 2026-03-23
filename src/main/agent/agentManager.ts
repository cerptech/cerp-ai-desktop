import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow } from 'electron'
import { createCerpMcpServer } from './mcpServer'
import { getCompanyId } from '../auth/apiKeyManager'
import { SYSTEM_PROMPT } from './systemPrompt'
import { CONSTRUCTION_AGENTS } from './agents'
import { HttpClient } from '../utils/httpClient'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AgentStreamEvent } from '../ipc/types'

// Track running queries (support parallel)
const activeQueries = new Map<string, AbortController>()
let currentSessionId: string | null = null

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
  logger.info('Session reset')
}

export function getSessionId(): string | null {
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

  // Get companyId from cached API key response (resolved at login time)
  const companyId = getCompanyId()
  logger.info(`[${queryId}] CompanyId for MCP: ${companyId}`)
  const cerpMcpServer = createCerpMcpServer(httpClient, companyId)

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

  try {
    const sessionId = payload.sessionId || currentSessionId
    const cwd = payload.cwd || app.getPath('home')

    logger.info(`[${queryId}] Running agent query: "${payload.prompt.slice(0, 80)}..." (session: ${sessionId || 'new'}, cwd: ${cwd})`)

    const startTime = Date.now()

    // Build subagent definitions
    const agents = CONSTRUCTION_AGENTS.map((a) => ({
      name: a.name,
      description: a.description,
      instructions: a.prompt,
    }))

    const options: Record<string, unknown> = {
      model,
      systemPrompt: SYSTEM_PROMPT,
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

    const q = query({
      prompt: payload.prompt,
      options: options as any,
    })

    let receivedResult = false

    for await (const msg of q) {
      // Check if aborted
      if (abortController.signal.aborted) break

      const msgType = (msg as any).type
      const msgSubtype = (msg as any).subtype

      // Capture session ID — check multiple possible locations
      if (!currentSessionId) {
        const sid = (msg as any).sessionId || (msg as any).session_id || (msg as any).id
        if (sid && typeof sid === 'string' && sid.length > 5) {
          currentSessionId = sid
          sendEvent({ type: 'session_id', sessionId: currentSessionId })
          logger.info(`[${queryId}] Session ID captured: ${currentSessionId}`)
        }
        // Log system messages to find session ID format
        if (msgType === 'system') {
          logger.info(`[${queryId}] System msg: ${JSON.stringify(msg).substring(0, 300)}`)
        }
      }

      const events = mapMessage(msg)
      if (events) {
        const arr = Array.isArray(events) ? events : [events]
        for (const event of arr) {
          if (event.type === 'done') receivedResult = true
          sendEvent(event)
        }
      }
    }

    const duration = Date.now() - startTime

    // Always send done even if we didn't get a result message
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
