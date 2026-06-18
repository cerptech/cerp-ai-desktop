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

/**
 * Pending resolvers keyed by conversationId — cada conversación puede tener su
 * propia ask_user_question en vuelo, ya que varias conversaciones corren a la vez.
 */
interface PendingQuestion {
  resolve: (answers: UserAnswerPayload) => void
  reject: (err: Error) => void
}
const pending = new Map<string, PendingQuestion>()

const DEFAULT_CONV = '__default__'

export function setAskUserWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/**
 * Called by the ask_user_question MCP tool handler.
 * Sends questions to the renderer (tagged with conversationId) and waits for answers.
 */
export async function waitForAnswer(
  conversationId: string,
  payload: AskUserQuestionPayload,
): Promise<UserAnswerPayload> {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    throw new Error('No active window to send questions to')
  }

  // If THIS conversation already has a pending question, reject the old one first
  const existing = pending.get(conversationId)
  if (existing) {
    logger.warn(`ask_user_question[${conversationId}]: new question before previous answered — cancelling previous`)
    existing.reject(new Error('Cancelled by new question'))
    pending.delete(conversationId)
  }

  return new Promise<UserAnswerPayload>((resolve, reject) => {
    pending.set(conversationId, { resolve, reject })
    logger.info(`ask_user_question[${conversationId}]: sending ${payload.questions.length} question(s) to renderer`)
    mainWindowRef!.webContents.send(IPC_CHANNELS.AGENT_ASK_USER_QUESTION, {
      conversationId,
      questions: payload.questions,
    })
  })
}

/**
 * Called by the IPC handler when the renderer sends back the user's answers.
 */
export function resolveAnswer(conversationId: string, answers: UserAnswerPayload): void {
  const entry = pending.get(conversationId)
  if (!entry) {
    logger.warn(`ask_user_question[${conversationId}]: got answer but no pending question — ignoring`)
    return
  }
  logger.info(`ask_user_question[${conversationId}]: received answers, resuming agent`)
  pending.delete(conversationId)
  entry.resolve(answers)
}

/**
 * Called when a session is closed or aborted — rejects its pending question.
 */
export function cancelPendingQuestion(conversationId: string = DEFAULT_CONV): void {
  const entry = pending.get(conversationId)
  if (entry) {
    logger.info(`ask_user_question[${conversationId}]: session cancelled — rejecting pending question`)
    pending.delete(conversationId)
    entry.reject(new Error('Session cancelled'))
  }
}
