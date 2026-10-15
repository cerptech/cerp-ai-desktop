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

import { BrowserWindow } from 'electron'
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

/**
 * Cola por conversación: una pregunta que llega mientras otra espera respuesta se
 * muestra DESPUÉS. Antes la nueva cancelaba a la anterior, que volvía al agente como
 * error ("Cancelled by new question") aunque el usuario la estuviera viendo.
 */
const queues = new Map<string, Promise<unknown>>()

/** Sube al cancelar: lo que estaba en cola para esa conversación ya no se muestra. */
const generations = new Map<string, number>()

const DEFAULT_CONV = '__default__'

export function setAskUserWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/**
 * Called by the ask_user_question MCP tool handler (y por las confirmaciones de
 * cronograma). Sends questions to the renderer (tagged with conversationId) and waits
 * for answers — one question set at a time per conversation (see `queues`).
 */
export async function waitForAnswer(
  conversationId: string,
  payload: AskUserQuestionPayload,
): Promise<UserAnswerPayload> {
  const generation = generations.get(conversationId) ?? 0
  const previous = queues.get(conversationId) ?? Promise.resolve()
  if (pending.has(conversationId)) {
    logger.info(`ask_user_question[${conversationId}]: another question is waiting — queued`)
  }
  const run = previous.then(() => {
    if ((generations.get(conversationId) ?? 0) !== generation) throw new Error('Session cancelled')
    return showAndWait(conversationId, payload)
  })
  const settled = run.catch(() => undefined)
  queues.set(conversationId, settled)
  void settled.then(() => {
    if (queues.get(conversationId) === settled) queues.delete(conversationId)
  })
  return run
}

/**
 * Ventana a la que mandar las preguntas. Si la referencia se perdió (logout/reset
 * global en medio de un turno: 2 casos de "No active window" en CRESATA, 2026-10), se
 * usa la ventana de la app que siga abierta antes de dar la pregunta por fallida.
 */
function targetWindow(): BrowserWindow | null {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

function showAndWait(conversationId: string, payload: AskUserQuestionPayload): Promise<UserAnswerPayload> {
  const win = targetWindow()
  if (!win) {
    throw new Error('No active window to send questions to')
  }
  return new Promise<UserAnswerPayload>((resolve, reject) => {
    pending.set(conversationId, { resolve, reject })
    logger.info(`ask_user_question[${conversationId}]: sending ${payload.questions.length} question(s) to renderer`)
    win.webContents.send(IPC_CHANNELS.AGENT_ASK_USER_QUESTION, {
      conversationId,
      questions: payload.questions,
    })
  })
}

/**
 * Called by the IPC handler when the renderer sends back the user's answers.
 * false = nadie esperaba esa respuesta (la ejecución que preguntó ya terminó): el
 * renderer la manda como un mensaje normal para que no se pierda.
 */
export function resolveAnswer(conversationId: string, answers: UserAnswerPayload): boolean {
  const entry = pending.get(conversationId)
  if (!entry) {
    logger.warn(`ask_user_question[${conversationId}]: got answer but no pending question — the renderer sends it as a message`)
    return false
  }
  logger.info(`ask_user_question[${conversationId}]: received answers, resuming agent`)
  pending.delete(conversationId)
  entry.resolve(answers)
  return true
}

/**
 * true mientras la conversación espera la respuesta del usuario a una pregunta
 * (ask_user_question o una confirmación de cronograma). El watchdog de turno no
 * cuenta ese tiempo como inactividad: es el usuario el que tiene que moverse.
 */
export function hasPendingQuestion(conversationId: string = DEFAULT_CONV): boolean {
  return pending.has(conversationId)
}

/**
 * Called when a session is closed or aborted — rejects its pending question.
 */
export function cancelPendingQuestion(conversationId: string = DEFAULT_CONV): void {
  generations.set(conversationId, (generations.get(conversationId) ?? 0) + 1)
  const entry = pending.get(conversationId)
  if (entry) {
    logger.info(`ask_user_question[${conversationId}]: session cancelled — rejecting pending question`)
    pending.delete(conversationId)
    entry.reject(new Error('Session cancelled'))
    // Que el renderer saque el widget: ya nadie espera esa respuesta (lista vacía = sin preguntas).
    targetWindow()?.webContents.send(IPC_CHANNELS.AGENT_ASK_USER_QUESTION, { conversationId, questions: [] })
  }
}
