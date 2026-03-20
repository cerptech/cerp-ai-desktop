export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string; summary?: string }
  | { type: 'status'; message: string }
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

interface CerpAPI {
  login(): Promise<AuthState>
  logout(): Promise<void>
  getAuthStatus(): Promise<AuthState>
  sendPrompt(payload: { prompt: string; maxTurns?: number; maxBudgetUsd?: number }): Promise<{ started: boolean; error?: string }>
  abortAgent(): Promise<void>
  onAgentMessage(callback: (event: AgentStreamEvent) => void): () => void
  onAgentDone(callback: () => void): () => void
  onAgentError(callback: (err: { message: string }) => void): () => void
  getVersion(): Promise<string>
}

declare global {
  interface Window {
    cerpAPI: CerpAPI
  }
}
