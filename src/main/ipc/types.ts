export interface ConversationHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

/** Elección de modelo del selector (Ola 1). 'auto' = el que devuelve /desktop/api-key. */
export type ModelChoice = 'auto' | 'fast' | 'powerful'

export interface SendPromptPayload {
  prompt: string
  sessionId?: string
  /**
   * Conversación a la que pertenece este prompt. El main mantiene una sesión del
   * SDK por conversationId, de modo que varias conversaciones corren en paralelo
   * sin pisarse. Si falta, cae en una sesión por defecto (comportamiento legacy).
   */
  conversationId?: string
  cwd?: string
  maxTurns?: number
  maxBudgetUsd?: number
  activeContextId?: string
  /**
   * Renderer-side conversation history. The main process inlines it into the
   * system prompt when starting a NEW SDK session, so model context survives
   * events that close the session (Plan Mode toggle, restored conversation,
   * cwd or context change). Ignored when the session is already open.
   */
  conversationHistory?: ConversationHistoryEntry[]
  /**
   * Selector de modelo (Ola 1). 'powerful' ("Potente") absorbe el antiguo Modo Turbo:
   * agentManager le aplica effort 'xhigh', habilita la tool Workflow y sube el techo
   * de presupuesto además de fijar el modelo Opus.
   */
  modelChoice?: ModelChoice
}

/** Adjunto validado (path real en disco + metadata) — dialog multiselección o drag&drop. */
export interface AttachmentFile {
  path: string
  name: string
  ext: string
  sizeBytes: number
}

/** Resultado de `dictation:transcribe`. `error` sigue la misma convención que el resto
 *  de las llamadas HTTP del main: 'auth' ya disparó AUTH_SESSION_EXPIRED, 'network' es
 *  cualquier otra falla, 'validation' es un problema con el audio en sí (vacío/grande). */
export interface DictationTranscribeResult {
  text?: string
  language?: string
  error?: 'auth' | 'network' | 'validation'
}

// IMPORTANT — tool lifecycle is keyed by `toolUseId`, NEVER by tool name.
// The Claude Agent SDK (0.3.x) delivers tool RESULTS as `type:'user'` messages whose
// content blocks are `{ type:'tool_result', tool_use_id, content, is_error }` — there is
// NO `type:'tool_result'` top-level message. Matching done→start by name is unreliable
// (duplicate names, missing name on results). Every tool_use block has a stable `id`;
// every tool_result carries the matching `tool_use_id`. We key on that everywhere.
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  // Delta de streaming token a token (Ola 2) — solo para el mensaje del asistente
  // de NIVEL SUPERIOR (parent_tool_use_id null). Los deltas de subagentes se
  // enrutan aparte vía `subagent_text` y nunca llegan como `text_delta`.
  // `index` es el índice del content block dentro del mensaje (varios bloques de
  // texto son raros pero posibles); el renderer acumula por índice.
  | { type: 'text_delta'; text: string; index: number }
  | { type: 'tool_start'; toolUseId: string; name: string; input?: string }
  | { type: 'tool_done'; toolUseId: string; output?: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  // Explicit turn-start signal — sent when the first system task_started arrives
  // so the renderer badge flips to "activa" even before the first text/tool event.
  | { type: 'stream_start' }
  | { type: 'session_id'; sessionId: string }
  // toolUseId links the delegation to the specific Agent ToolExecution it created
  | { type: 'agent_delegation'; toolUseId: string; agentName: string; task: string }
  | { type: 'prompt_suggestions'; suggestions: string[] }
  | { type: 'ask_user_question'; questions: AskUserQuestionItem[] }
  // Subagent inner activity — tool calls made INSIDE a delegated subagent.
  // parentToolUseId = the Agent tool_use_id that spawned the subagent;
  // toolUseId = the subagent's own inner tool_use id (keys done→start).
  | { type: 'subagent_tool_start'; parentToolUseId: string; toolUseId: string; agentName: string; name: string; input?: string }
  | { type: 'subagent_tool_done'; parentToolUseId: string; toolUseId: string; output?: string; isError?: boolean }
  // Subagent text/reasoning forwarded in real-time (requires forwardSubagentText: true, SDK ≥ 0.2.119).
  | { type: 'subagent_text'; parentToolUseId: string; agentName: string; text: string }
  // Lienzo HTML del agente (tool `show_html`, MCP server `cerp`). Emitido por
  // htmlCanvasBridge en el momento en que se ejecuta la tool, NO por el mapeo
  // genérico tool_start/tool_done (que trunca input/output a 200/800 chars).
  | { type: 'html_canvas'; toolUseId: string; title: string; html: string }
  | { type: 'done'; cost?: number; turns?: number; duration?: number; tokensIn?: number; tokensOut?: number }
  // `code` distinguishes specific error causes the renderer needs to react to differently
  // (e.g. 'NO_CREDITS' → paywall banner instead of the generic error toast).
  | { type: 'error'; message: string; code?: string }

export interface AuthState {
  isAuthenticated: boolean
  user?: {
    name: string
    email: string
    picture?: string
    companyId: string
    companyName: string
  }
}

export interface DesktopConfig {
  apiKey: string
  companyId: string
  userId: string
  maxBudgetPerQuery: number
  model: string
  /**
   * Techo de coste por sesión según el plan de la empresa (Modelo CERP / créditos).
   * Puede faltar si el backend desplegado aún no incluye este campo — el caller
   * debe usar el fallback hardcodeado en ese caso.
   */
  maxBudgetUsd?: number
  /**
   * Mismo techo pero para el modo "Potente" (Opus + xhigh). El nombre del campo se
   * mantiene igual al que ya devuelve el backend (`maxBudgetUsdTurbo`, heredado del
   * antiguo Modo Turbo) para no requerir un cambio de contrato ahí.
   */
  maxBudgetUsdTurbo?: number
}

// ── ask_user_question tool types ──

export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  multiSelect: boolean
  options: AskUserQuestionOption[]
}

export interface AskUserQuestionPayload {
  questions: AskUserQuestionItem[]
}

/** Map of question text → chosen label(s) or "Otro: <free text>" */
export type UserAnswerPayload = Record<string, string | string[]>

export interface SubagentStep {
  /** The subagent's own inner tool_use id — keys done→start. */
  toolUseId?: string
  name: string
  input?: string
  output?: string
  status: 'running' | 'done' | 'error'
  startTime: number
  endTime?: number
}

/** Lienzo HTML emitido por la tool `show_html` durante el turno. */
export interface HtmlCanvas {
  toolUseId: string
  title: string
  html: string
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  agentContext?: string
  tools?: Array<{
    name: string
    input?: string
    output?: string
    status: string
    startTime: number
    endTime?: number
    agentName?: string
    /** Sub-steps from the subagent's own tool calls, keyed by parentToolUseId */
    subagentSteps?: SubagentStep[]
    /** Live text/reasoning streamed from the subagent (Fase 2, forwardSubagentText) */
    subagentText?: string
  }>
  /** Lienzos HTML emitidos por show_html durante este turno del asistente. */
  htmlCanvases?: HtmlCanvas[]
  timestamp: number
}

export interface ConversationSummary {
  _id: string
  title: string
  agentName: string
  updatedAt: string
  messageCount: number
}

export interface ConversationFull extends ConversationSummary {
  sessionId?: string
  activeContextId?: string
  messages: ConversationMessage[]
  metadata?: {
    cwd?: string | null
    totalCostUsd?: number
    totalTurns?: number
  }
}
