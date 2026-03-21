export interface SendPromptPayload {
  prompt: string
  sessionId?: string
  cwd?: string
  maxTurns?: number
  maxBudgetUsd?: number
}

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input?: string }
  | { type: 'tool_done'; name: string; output?: string }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  | { type: 'session_id'; sessionId: string }
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

export interface DesktopConfig {
  apiKey: string
  maxBudgetPerQuery: number
  model: string
}
