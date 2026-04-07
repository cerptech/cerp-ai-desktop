export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input?: string }
  | { type: 'tool_done'; name: string; output?: string }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  | { type: 'session_id'; sessionId: string }
  | { type: 'agent_delegation'; agentName: string; task: string }
  | { type: 'done'; cost?: number; turns?: number; duration?: number }
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
  sendPrompt(payload: { prompt: string; sessionId?: string; cwd?: string; maxTurns?: number; maxBudgetUsd?: number; activeContextId?: string }): Promise<{ started: boolean; error?: string }>
  abortAgent(): Promise<void>
  resetSession(): Promise<void>
  selectFolder(): Promise<string | null>
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
  getVersion(): Promise<string>
  checkPython(): Promise<{ installed: boolean; version?: string; pipInstalled: boolean }>
  installPython(): Promise<boolean>
  onPythonProgress(callback: (data: { message: string; percent: number }) => void): () => void
}

declare global {
  interface Window {
    cerpAPI: CerpAPI
  }
}
