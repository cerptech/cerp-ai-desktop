import { useCallback, useSyncExternalStore } from 'react'
import type { AskUserQuestionItem, UserAnswerPayload, ModelChoice, HtmlCanvas } from '../../../preload/index'
import {
  getRuntime,
  subscribe,
  ensureIpcWired,
  sendPrompt as storeSendPrompt,
  abort as storeAbort,
  submitAnswers as storeSubmitAnswers,
  restoreMessages as storeRestoreMessages,
  clearRuntime,
} from '../stores/agentRuntimeStore'

// ── Tipos compartidos (consumidos por el store y los componentes) ─────────────

export interface SubagentStep {
  /** The subagent's own inner tool_use id — keys done→start (never by name). */
  toolUseId?: string
  name: string
  input?: string
  output?: string
  status: 'running' | 'done' | 'error'
  startTime: number
  endTime?: number
}

export interface ToolExecution {
  name: string
  input?: string
  output?: string
  status: 'running' | 'done' | 'error'
  timestamp: number
  startTime: number
  endTime?: number
  agentName?: string
  /** Tool_use_id of the Agent delegation — used to key subagentSteps */
  toolUseId?: string
  /** Inner tool calls the subagent made, accumulated as subagent_tool_start/done events arrive */
  subagentSteps?: SubagentStep[]
  /** Latest text/reasoning streamed from the subagent (forwardSubagentText, Fase 2) */
  subagentText?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolExecution[]
  /** Lienzos HTML emitidos por show_html durante este turno (Ola — lienzo HTML dinámico). */
  htmlCanvases?: HtmlCanvas[]
  timestamp: number
  agentContext?: string
}

export interface AgentDelegation {
  agentName: string
  task: string
}

const DEFAULT_CONV = '__default__'

/**
 * useAgent — vista React del runtime de UNA conversación.
 *
 * El estado de streaming vive en agentRuntimeStore (keyed por conversationId), así
 * que varias conversaciones corren en paralelo: esta hook sólo SELECCIONA la del
 * id que se le pasa y se re-renderiza cuando ese runtime cambia. Cambiar de
 * conversación NO mata las demás — siguen corriendo en el store.
 */
export function useAgent(conversationId: string = DEFAULT_CONV) {
  // Asegura la suscripción IPC global (idempotente).
  ensureIpcWired()

  const rt = useSyncExternalStore(
    (cb) => subscribe(conversationId, cb),
    () => getRuntime(conversationId),
  )

  const sendPrompt = useCallback(
    (prompt: string, cwd?: string, activeContextId?: string, modelChoice?: ModelChoice) =>
      storeSendPrompt(conversationId, prompt, cwd, activeContextId, modelChoice),
    [conversationId],
  )

  const abort = useCallback(() => storeAbort(conversationId), [conversationId])

  const submitAnswers = useCallback(
    (answers: UserAnswerPayload) => storeSubmitAnswers(conversationId, rt.pendingQuestions ?? [], answers),
    [conversationId, rt.pendingQuestions],
  )

  const restoreMessages = useCallback(
    (msgs: ChatMessage[], cwd?: string | null) => storeRestoreMessages(conversationId, msgs, cwd),
    [conversationId],
  )

  const clearMessages = useCallback(() => clearRuntime(conversationId), [conversationId])

  return {
    messages: rt.messages,
    isStreaming: rt.isStreaming,
    isPending: rt.isPending,
    activeTool: rt.activeTool,
    error: rt.error,
    errorCode: rt.errorCode,
    activeAgentDelegation: rt.activeAgentDelegation,
    promptSuggestions: rt.promptSuggestions,
    statusMessage: rt.statusMessage,
    sessionTokensIn: rt.sessionTokensIn,
    sessionTokensOut: rt.sessionTokensOut,
    pendingQuestions: rt.pendingQuestions as AskUserQuestionItem[] | null,
    isSubmittingAnswers: rt.isSubmittingAnswers,
    cwd: rt.cwd,
    sendPrompt,
    abort,
    submitAnswers,
    clearMessages,
    restoreMessages,
  }
}
