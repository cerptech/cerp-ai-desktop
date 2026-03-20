import { contextBridge, ipcRenderer } from 'electron'

const IPC = {
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATUS: 'auth:get-status',
  AGENT_SEND_PROMPT: 'agent:send-prompt',
  AGENT_ABORT: 'agent:abort',
  AGENT_STREAM_MESSAGE: 'agent:stream:message',
  AGENT_STREAM_DONE: 'agent:stream:done',
  AGENT_STREAM_ERROR: 'agent:stream:error',
  APP_GET_VERSION: 'app:get-version',
} as const

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

const api = {
  // Auth
  login: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAuthStatus: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_GET_STATUS),

  // Agent
  sendPrompt: (payload: { prompt: string; maxTurns?: number; maxBudgetUsd?: number }): Promise<{ started: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.AGENT_SEND_PROMPT, payload),
  abortAgent: (): Promise<void> => ipcRenderer.invoke(IPC.AGENT_ABORT),

  // Stream listeners
  onAgentMessage: (callback: (event: AgentStreamEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: AgentStreamEvent): void => callback(data)
    ipcRenderer.on(IPC.AGENT_STREAM_MESSAGE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STREAM_MESSAGE, handler)
  },
  onAgentDone: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC.AGENT_STREAM_DONE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STREAM_DONE, handler)
  },
  onAgentError: (callback: (err: { message: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { message: string }): void => callback(data)
    ipcRenderer.on(IPC.AGENT_STREAM_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STREAM_ERROR, handler)
  },

  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),
}

contextBridge.exposeInMainWorld('cerpAPI', api)
