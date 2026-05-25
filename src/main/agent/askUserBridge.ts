/**
 * askUserBridge — coordinates the ask_user_question MCP tool with the renderer.
 *
 * When the agent invokes ask_user_question, the MCP handler calls waitForAnswer(),
 * which:
 *   1. Emits the questions to the renderer via the main window.
 *   2. Suspends the MCP tool execution until the renderer calls resolveAnswer().
 *
 * The renderer sends answers back via IPC → handlers.ts calls resolveAnswer().
 */

import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import type { AskUserQuestionPayload, UserAnswerPayload } from '../ipc/types'
import { logger } from '../utils/logger'

let mainWindowRef: BrowserWindow | null = null

/** Pending resolver — only one ask_user_question can be in flight at a time. */
let pendingResolve: ((answers: UserAnswerPayload) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null

export function setAskUserWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/**
 * Called by the ask_user_question MCP tool handler.
 * Sends questions to the renderer and waits for the user's answers.
 */
export async function waitForAnswer(payload: AskUserQuestionPayload): Promise<UserAnswerPayload> {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    throw new Error('No active window to send questions to')
  }

  // If there's already a pending question, reject the old one first
  if (pendingResolve) {
    logger.warn('ask_user_question: new question arrived before previous was answered — cancelling previous')
    pendingReject?.(new Error('Cancelled by new question'))
    pendingResolve = null
    pendingReject = null
  }

  return new Promise<UserAnswerPayload>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject

    logger.info(`ask_user_question: sending ${payload.questions.length} question(s) to renderer`)
    mainWindowRef!.webContents.send(IPC_CHANNELS.AGENT_ASK_USER_QUESTION, payload)
  })
}

/**
 * Called by the IPC handler when the renderer sends back the user's answers.
 */
export function resolveAnswer(answers: UserAnswerPayload): void {
  if (!pendingResolve) {
    logger.warn('ask_user_question: got answer but no pending question — ignoring')
    return
  }
  logger.info('ask_user_question: received answers, resuming agent')
  const resolve = pendingResolve
  pendingResolve = null
  pendingReject = null
  resolve(answers)
}

/**
 * Called when the session is closed or aborted — rejects any pending question.
 */
export function cancelPendingQuestion(): void {
  if (pendingReject) {
    logger.info('ask_user_question: session cancelled — rejecting pending question')
    pendingReject(new Error('Session cancelled'))
    pendingResolve = null
    pendingReject = null
  }
}
