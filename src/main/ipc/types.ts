export interface SendPromptPayload {
  prompt: string
  sessionId?: string
  cwd?: string
  maxTurns?: number
  maxBudgetUsd?: number
  activeContextId?: string
}

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input?: string }
  | { type: 'tool_done'; name: string; output?: string }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  | { type: 'session_id'; sessionId: string }
  | { type: 'agent_delegation'; agentName: string; task: string }
  | { type: 'prompt_suggestions'; suggestions: string[] }
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
