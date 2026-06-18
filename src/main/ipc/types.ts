export interface ConversationHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

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
}

// IMPORTANT — tool lifecycle is keyed by `toolUseId`, NEVER by tool name.
// The Claude Agent SDK (0.3.x) delivers tool RESULTS as `type:'user'` messages whose
// content blocks are `{ type:'tool_result', tool_use_id, content, is_error }` — there is
// NO `type:'tool_result'` top-level message. Matching done→start by name is unreliable
// (duplicate names, missing name on results). Every tool_use block has a stable `id`;
// every tool_result carries the matching `tool_use_id`. We key on that everywhere.
export type AgentStreamEvent =
  | { type: 'text'; text: string }
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
  | { type: 'done'; cost?: number; turns?: number; duration?: number; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string }

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
    cwd?: string
    totalCostUsd?: number
    totalTurns?: number
  }
}
