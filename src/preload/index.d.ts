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

export type UserAnswerPayload = Record<string, string | string[]>

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolUseId: string; name: string; input?: string }
  | { type: 'tool_done'; toolUseId: string; output?: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  | { type: 'stream_start' }
  | { type: 'session_id'; sessionId: string }
  | { type: 'agent_delegation'; toolUseId: string; agentName: string; task: string }
  | { type: 'prompt_suggestions'; suggestions: string[] }
  | { type: 'ask_user_question'; questions: AskUserQuestionItem[] }
  // Subagent inner activity — tool calls made INSIDE a delegated subagent.
  | { type: 'subagent_tool_start'; parentToolUseId: string; toolUseId: string; agentName: string; name: string; input?: string }
  | { type: 'subagent_tool_done'; parentToolUseId: string; toolUseId: string; output?: string; isError?: boolean }
  // Subagent text/reasoning forwarded in real-time (requires forwardSubagentText: true, SDK >= 0.2.119).
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

export interface CustomContext {
  id: string
  name: string
  icon: string
  instructions: string
  createdAt: string
  updatedAt: string
}

export interface CustomAgent {
  id: string
  name: string
  label: string
  description: string
  icon: string
  systemPrompt: string
  allowedTools: string[]
  createdAt: string
  updatedAt: string
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
  messages: Array<{
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
      subagentSteps?: Array<{
        name: string
        input?: string
        output?: string
        status: 'running' | 'done' | 'error'
        startTime: number
        endTime?: number
      }>
      subagentText?: string
    }>
    timestamp: number
  }>
  metadata?: {
    cwd?: string
    totalCostUsd?: number
    totalTurns?: number
  }
}

interface CerpAPI {
  login(): Promise<AuthState>
  logout(): Promise<void>
  getAuthStatus(): Promise<AuthState>
  sendPrompt(payload: { prompt: string; sessionId?: string; cwd?: string; maxTurns?: number; maxBudgetUsd?: number; activeContextId?: string; conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ started: boolean; error?: string }>
  abortAgent(): Promise<void>
  resetSession(): Promise<void>
  setPlanMode(enabled: boolean): Promise<void>
  getPlanMode(): Promise<boolean>
  selectFolder(): Promise<string | null>
  onAskUserQuestion(callback: (questions: AskUserQuestionItem[]) => void): () => void
  submitUserAnswers(answers: UserAnswerPayload): Promise<void>
  onAgentMessage(callback: (event: AgentStreamEvent) => void): () => void
  onAgentDone(callback: () => void): () => void
  onAgentError(callback: (err: { message: string }) => void): () => void
  listCustomContexts(): Promise<CustomContext[]>
  createCustomContext(ctx: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomContext>
  updateCustomContext(id: string, updates: Partial<CustomContext>): Promise<CustomContext | null>
  deleteCustomContext(id: string): Promise<boolean>
  listCustomAgents(): Promise<CustomAgent[]>
  createCustomAgent(agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomAgent>
  updateCustomAgent(id: string, updates: Partial<CustomAgent>): Promise<CustomAgent | null>
  deleteCustomAgent(id: string): Promise<boolean>
  listConversations(page?: number, limit?: number): Promise<{ data: ConversationSummary[]; pagination: { currentPage: number; totalPages: number; totalItems: number } }>
  getConversation(id: string): Promise<{ data: ConversationFull } | null>
  createConversation(data: { title: string; agentName: string; sessionId?: string; activeContextId?: string; metadata?: Record<string, unknown> }): Promise<{ data: ConversationFull } | null>
  appendConversationMessage(conversationId: string, message: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<boolean>
  deleteConversation(id: string): Promise<boolean>
  getQuoteEligibility(): Promise<{
    canQuote: boolean
    freeAvailable: boolean
    freeSource: 'trial_free' | 'monthly_free' | null
    priceCents: number
    currency: string
    paidThisMonth: number
    prepaidCredits: number
    unlimited: boolean
    blockedReason?: 'no_subscription' | 'subscription_inactive'
  } | null>
  consumeUnlimitedQuote(): Promise<{ quote: Record<string, unknown> } | null>
  listQuotes(page?: number, pageSize?: number): Promise<{
    items: Array<Record<string, unknown>>
    page: number
    pageSize: number
    total: number
  }>
  getVersion(): Promise<string>
  onUpdateAvailable(callback: (data: { version: string }) => void): () => void
  onUpdateDownloadProgress(callback: (data: { percent: number }) => void): () => void
  onUpdateDownloaded(callback: (data: { version: string }) => void): () => void
  quitAndInstallUpdate(): Promise<void>
  checkPython(): Promise<{ installed: boolean; version?: string; pipInstalled: boolean }>
  installPython(): Promise<boolean>
  onPythonProgress(callback: (data: { message: string; percent: number }) => void): () => void
  checkGit(): Promise<{ installed: boolean; version?: string }>
  installGit(): Promise<boolean>
  onGitProgress(callback: (data: { message: string; percent: number }) => void): () => void
}

declare global {
  interface Window {
    cerpAPI: CerpAPI
  }
}
