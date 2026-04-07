import { contextBridge, ipcRenderer } from 'electron'

const IPC = {
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATUS: 'auth:get-status',
  AGENT_SEND_PROMPT: 'agent:send-prompt',
  AGENT_ABORT: 'agent:abort',
  AGENT_RESET_SESSION: 'agent:reset-session',
  AGENT_STREAM_MESSAGE: 'agent:stream:message',
  AGENT_STREAM_DONE: 'agent:stream:done',
  AGENT_STREAM_ERROR: 'agent:stream:error',
  SELECT_FOLDER: 'dialog:select-folder',
  CUSTOM_CONTEXTS_LIST: 'custom:contexts:list',
  CUSTOM_CONTEXT_CREATE: 'custom:context:create',
  CUSTOM_CONTEXT_UPDATE: 'custom:context:update',
  CUSTOM_CONTEXT_DELETE: 'custom:context:delete',
  CUSTOM_AGENTS_LIST: 'custom:agents:list',
  CUSTOM_AGENT_CREATE: 'custom:agent:create',
  CUSTOM_AGENT_UPDATE: 'custom:agent:update',
  CUSTOM_AGENT_DELETE: 'custom:agent:delete',
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_APPEND_MESSAGE: 'conversation:append-message',
  CONVERSATION_DELETE: 'conversation:delete',
  APP_GET_VERSION: 'app:get-version',
  PYTHON_CHECK: 'python:check',
  PYTHON_INSTALL: 'python:install',
  PYTHON_INSTALL_PROGRESS: 'python:install:progress',
  GIT_CHECK: 'git:check',
  GIT_INSTALL: 'git:install',
  GIT_INSTALL_PROGRESS: 'git:install:progress',
} as const

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input?: string }
  | { type: 'tool_done'; name: string; output?: string }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  | { type: 'session_id'; sessionId: string }
  | { type: 'agent_delegation'; agentName: string; task: string }
  | { type: 'prompt_suggestions'; suggestions: string[] }
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

const api = {
  // Auth
  login: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAuthStatus: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_GET_STATUS),

  // Agent
  sendPrompt: (payload: { prompt: string; sessionId?: string; cwd?: string; maxTurns?: number; maxBudgetUsd?: number; activeContextId?: string }): Promise<{ started: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.AGENT_SEND_PROMPT, payload),
  abortAgent: (): Promise<void> => ipcRenderer.invoke(IPC.AGENT_ABORT),
  resetSession: (): Promise<void> => ipcRenderer.invoke(IPC.AGENT_RESET_SESSION),

  // Files
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.SELECT_FOLDER),

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

  // Custom contexts
  listCustomContexts: (): Promise<CustomContext[]> => ipcRenderer.invoke(IPC.CUSTOM_CONTEXTS_LIST),
  createCustomContext: (ctx: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomContext> =>
    ipcRenderer.invoke(IPC.CUSTOM_CONTEXT_CREATE, ctx),
  updateCustomContext: (id: string, updates: Partial<CustomContext>): Promise<CustomContext | null> =>
    ipcRenderer.invoke(IPC.CUSTOM_CONTEXT_UPDATE, { id, updates }),
  deleteCustomContext: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.CUSTOM_CONTEXT_DELETE, id),

  // Custom agents
  listCustomAgents: (): Promise<CustomAgent[]> => ipcRenderer.invoke(IPC.CUSTOM_AGENTS_LIST),
  createCustomAgent: (agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomAgent> =>
    ipcRenderer.invoke(IPC.CUSTOM_AGENT_CREATE, agent),
  updateCustomAgent: (id: string, updates: Partial<CustomAgent>): Promise<CustomAgent | null> =>
    ipcRenderer.invoke(IPC.CUSTOM_AGENT_UPDATE, { id, updates }),
  deleteCustomAgent: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.CUSTOM_AGENT_DELETE, id),

  // Conversations
  listConversations: (page?: number, limit?: number): Promise<any> =>
    ipcRenderer.invoke(IPC.CONVERSATION_LIST, { page, limit }),
  getConversation: (id: string): Promise<any> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GET, id),
  createConversation: (data: { title: string; agentName: string; sessionId?: string; activeContextId?: string; metadata?: Record<string, unknown> }): Promise<any> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, data),
  appendConversationMessage: (conversationId: string, message: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_APPEND_MESSAGE, { conversationId, message, metadata }),
  deleteConversation: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),

  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),

  // Setup (Python + Git)
  checkPython: (): Promise<{ installed: boolean; version?: string; pipInstalled: boolean }> =>
    ipcRenderer.invoke(IPC.PYTHON_CHECK),
  installPython: (): Promise<boolean> => ipcRenderer.invoke(IPC.PYTHON_INSTALL),
  onPythonProgress: (callback: (data: { message: string; percent: number }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { message: string; percent: number }): void => callback(data)
    ipcRenderer.on(IPC.PYTHON_INSTALL_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.PYTHON_INSTALL_PROGRESS, handler)
  },
  checkGit: (): Promise<{ installed: boolean; version?: string }> =>
    ipcRenderer.invoke(IPC.GIT_CHECK),
  installGit: (): Promise<boolean> => ipcRenderer.invoke(IPC.GIT_INSTALL),
  onGitProgress: (callback: (data: { message: string; percent: number }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { message: string; percent: number }): void => callback(data)
    ipcRenderer.on(IPC.GIT_INSTALL_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.GIT_INSTALL_PROGRESS, handler)
  },
}

contextBridge.exposeInMainWorld('cerpAPI', api)
