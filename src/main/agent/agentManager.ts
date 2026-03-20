import { query } from '@anthropic-ai/claude-agent-sdk'
import { BrowserWindow } from 'electron'
import { createCerpMcpServer } from './mcpServer'
import { SYSTEM_PROMPT } from './systemPrompt'
import { HttpClient } from '../utils/httpClient'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AgentStreamEvent } from '../ipc/types'

let activeAbortController: AbortController | null = null
let isRunning = false

export function isAgentRunning(): boolean {
  return isRunning
}

export function abortAgent(): void {
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
    isRunning = false
    logger.info('Agent aborted by user')
  }
}

export async function runAgent(
  payload: SendPromptPayload,
  apiKey: string,
  model: string,
  httpClient: HttpClient,
  mainWindow: BrowserWindow,
): Promise<void> {
  if (isRunning) {
    throw new Error('An agent query is already running')
  }

  isRunning = true
  activeAbortController = new AbortController()

  const cerpMcpServer = createCerpMcpServer(httpClient)

  const sendEvent = (event: AgentStreamEvent): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, event)
    }
  }

  try {
    logger.info(`Running agent query: "${payload.prompt.slice(0, 80)}..."`)

    const startTime = Date.now()

    const q = query({
      prompt: payload.prompt,
      options: {
        model,
        systemPrompt: SYSTEM_PROMPT,
        cwd: process.cwd(),
        env: {
          ANTHROPIC_API_KEY: apiKey,
        },
        mcpServers: {
          cerp: cerpMcpServer,
        },
        permissionMode: 'bypassPermissions',
        maxTurns: payload.maxTurns ?? 25,
        maxBudgetUsd: payload.maxBudgetUsd ?? 0.5,
        includePartialMessages: true,
        abortController: activeAbortController,
      },
    })

    for await (const msg of q) {
      const event = mapMessage(msg)
      if (event) sendEvent(event)
    }

    const duration = Date.now() - startTime
    sendEvent({ type: 'done', duration })
    logger.info(`Agent query completed in ${duration}ms`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (message.includes('aborted')) {
      sendEvent({ type: 'done' })
    } else {
      logger.error('Agent error:', message)
      sendEvent({ type: 'error', message })
    }
  } finally {
    isRunning = false
    activeAbortController = null

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, {})
    }
  }
}

/**
 * Maps Agent SDK messages to simplified AgentStreamEvents.
 * The SDK emits 17+ message types — we extract only what the UI needs.
 */
function mapMessage(msg: Record<string, unknown>): AgentStreamEvent | null {
  const type = msg.type as string

  // Assistant text (partial or complete)
  if (type === 'assistant') {
    const content = msg.message as { content?: Array<{ type: string; text?: string }> }
    if (content?.content) {
      const textBlocks = content.content.filter((b) => b.type === 'text' && b.text)
      const text = textBlocks.map((b) => b.text).join('')
      if (text) return { type: 'text', text }
    }
  }

  // Tool use
  if (type === 'tool_use' || (msg.subtype === 'tool_use')) {
    const name = (msg as Record<string, unknown>).name as string || 'tool'
    return { type: 'tool_start', name }
  }

  // Tool result
  if (type === 'tool_result') {
    const name = (msg as Record<string, unknown>).name as string || 'tool'
    return { type: 'tool_done', name }
  }

  // System status messages
  if (type === 'system') {
    const subtype = msg.subtype as string
    if (subtype === 'status') {
      return { type: 'status', message: (msg.message as string) || '' }
    }
  }

  // Result
  if (type === 'result') {
    const cost = (msg as Record<string, unknown>).cost_usd as number | undefined
    const turns = (msg as Record<string, unknown>).num_turns as number | undefined
    return { type: 'done', cost, turns }
  }

  return null
}
