import { contextBridge, ipcRenderer, webUtils } from 'electron'

const IPC = {
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_SESSION_EXPIRED: 'auth:session-expired',
  AGENT_SEND_PROMPT: 'agent:send-prompt',
  AGENT_ABORT: 'agent:abort',
  AGENT_RESET_SESSION: 'agent:reset-session',
  AGENT_SET_PLAN_MODE: 'agent:set-plan-mode',
  AGENT_GET_PLAN_MODE: 'agent:get-plan-mode',
  AGENT_ASK_USER_QUESTION: 'agent:ask_user_question',
  AGENT_USER_ANSWER: 'agent:user_answer',
  QUOTE_FIREWALL_EVENT: 'quote:firewall:event',
  CANVAS_REGISTER: 'canvas:register',
  CANVAS_OPEN_EXTERNAL: 'canvas:open-external',
  AGENT_STREAM_MESSAGE: 'agent:stream:message',
  AGENT_STREAM_DONE: 'agent:stream:done',
  AGENT_STREAM_ERROR: 'agent:stream:error',
  SELECT_FOLDER: 'dialog:select-folder',
  SELECT_ATTACHMENTS: 'dialog:select-attachments',
  EXPORT_CONVERSATION: 'dialog:export-conversation',
  DICTATION_TRANSCRIBE: 'dictation:transcribe',
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
  QUOTES_GET_ELIGIBILITY: 'quotes:get-eligibility',
  QUOTES_LIST: 'quotes:list',
  QUOTES_CONSUME_UNLIMITED: 'quotes:consume-unlimited',
  CREDITS_GET_BALANCE: 'credits:get-balance',
  CREDITS_GET_LEDGER: 'credits:get-ledger',
  ONBOARDING_GET_PROGRESS: 'onboarding:get-progress',
  ONBOARDING_PATCH_PROGRESS: 'onboarding:patch-progress',
  APP_GET_VERSION: 'app:get-version',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_DOWNLOAD_PROGRESS: 'update:download-progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_QUIT_AND_INSTALL: 'update:quit-and-install',
  PYTHON_CHECK: 'python:check',
  PYTHON_INSTALL: 'python:install',
  PYTHON_INSTALL_PROGRESS: 'python:install:progress',
  GIT_CHECK: 'git:check',
  GIT_INSTALL: 'git:install',
  GIT_INSTALL_PROGRESS: 'git:install:progress',
} as const

/** Progress of the Desktop guided tutorial (Idea 1). */
export interface OnboardingProgress {
  currentStep: number
  completedSteps: number[]
  skipped: boolean
  completedAt: string | null
  lastSeenAt: string
  version: number
  totalSteps: number
  isCompleted: boolean
}

/** Backend response wrapper for onboarding progress (null on failure). */
export type OnboardingProgressResponse = { success: boolean; data: OnboardingProgress } | null

/** Partial update sent to PATCH /onboarding/desktop-progress. */
export interface OnboardingProgressUpdate {
  viewStep?: number
  completeStep?: number
  currentStep?: number
  skipped?: boolean
  completed?: boolean
  relaunch?: boolean
}

/** Elección de modelo del selector (Ola 1). 'auto' = el que devuelve /desktop/api-key. */
export type ModelChoice = 'auto' | 'fast' | 'powerful'

/** Adjunto validado (path real en disco + metadata) — dialog multiselección o drag&drop. */
export interface AttachmentFile {
  path: string
  name: string
  ext: string
  sizeBytes: number
}

/** Resultado de `dictation:transcribe`. 'auth' ya disparó AUTH_SESSION_EXPIRED (el modal
 *  global de sesión expirada ya se está mostrando); 'network' es cualquier otra falla;
 *  'validation' es un problema con el audio en sí (vacío o > 25 MB). */
export interface DictationTranscribeResult {
  text?: string
  language?: string
  error?: 'auth' | 'network' | 'validation'
}

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

/** Map of question text → chosen label or "Otro: <free text>" (or array for multiSelect) */
export type UserAnswerPayload = Record<string, string | string[]>

/** Cortafuegos de cotización (Idea 2) — eventos de estado main → renderer. */
export type QuoteFirewallEvent =
  | { kind: 'reserved'; quoteId: string; source: string; requiresAction: boolean }
  | { kind: 'committed'; quoteId: string }
  | { kind: 'rolled_back'; quoteId: string; reason: string; message: string; failures: string[] }

// Tool lifecycle is keyed by `toolUseId` (never by name). SDK 0.3.x delivers tool
// results as `type:'user'` messages with tool_result content blocks carrying tool_use_id.
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  // Delta de streaming token a token (Ola 2) — solo del mensaje de nivel
  // superior; los deltas de subagentes van por `subagent_text` aparte.
  | { type: 'text_delta'; text: string; index: number }
  | { type: 'tool_start'; toolUseId: string; name: string; input?: string }
  | { type: 'tool_done'; toolUseId: string; output?: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'status'; message: string }
  // Explicit turn-start signal — sent when the first system task_started arrives
  // so the renderer badge flips to "activa" even before the first text/tool event.
  | { type: 'stream_start' }
  | { type: 'session_id'; sessionId: string }
  | { type: 'agent_delegation'; toolUseId: string; agentName: string; task: string }
  | { type: 'prompt_suggestions'; suggestions: string[] }
  | { type: 'ask_user_question'; questions: AskUserQuestionItem[] }
  // Subagent inner activity — tool calls made INSIDE a delegated subagent.
  // parentToolUseId links to the Agent tool_use_id that spawned the subagent;
  // toolUseId is the subagent's own inner tool id (keys done→start).
  | { type: 'subagent_tool_start'; parentToolUseId: string; toolUseId: string; agentName: string; name: string; input?: string }
  | { type: 'subagent_tool_done'; parentToolUseId: string; toolUseId: string; output?: string; isError?: boolean }
  // Subagent text/reasoning forwarded in real-time (requires forwardSubagentText: true, SDK >= 0.2.119).
  | { type: 'subagent_text'; parentToolUseId: string; agentName: string; text: string }
  // Lienzo HTML del agente (tool `show_html`) — ver htmlCanvasBridge.ts en main.
  | { type: 'html_canvas'; toolUseId: string; title: string; html: string }
  | { type: 'done'; cost?: number; turns?: number; duration?: number; tokensIn?: number; tokensOut?: number }
  // `code` distinguishes specific error causes the renderer needs to react to differently
  // (e.g. 'NO_CREDITS' → paywall banner instead of the generic error toast).
  | { type: 'error'; message: string; code?: string }

/** Lienzo HTML emitido por la tool `show_html` durante un turno del asistente. */
export interface HtmlCanvas {
  toolUseId: string
  title: string
  html: string
}

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

/** Distingue por qué falló una llamada al backend: 'auth' ya disparó el modal
 *  global de sesión expirada (el renderer no debe mostrar un error propio
 *  además); 'network' es cualquier otra falla (red, 5xx) — ahí sí corresponde
 *  un estado de error visible con reintento. */
export type ApiErrorCode = 'auth' | 'network'

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
    htmlCanvases?: HtmlCanvas[]
    timestamp: number
  }>
  metadata?: {
    cwd?: string | null
    totalCostUsd?: number
    totalTurns?: number
  }
}

/** Modelo CERP — balance de créditos de IA de la empresa (GET /api/credits/balance). */
export interface CreditsBalance {
  mode: 'off' | 'shadow' | 'enforce'
  plan: string
  unlimited: boolean
  planBalanceHundredths: number
  topupBalanceHundredths: number
  reservedHundredths: number
  availableHundredths: number
  monthlyCreditHundredths: number
}

export type CreditLedgerEntryType =
  | 'grant_monthly'
  | 'grant_trial'
  | 'grant_topup'
  | 'grant_admin'
  | 'debit_usage'
  | 'reserve'
  | 'reserve_commit'
  | 'reserve_release'
  | 'adjustment'

export interface CreditLedgerEntry {
  id: string
  type: CreditLedgerEntryType
  amountHundredths: number
  kind?: string
  shadow?: boolean
  createdAt: string
  note?: string
}

export interface CreditsLedgerResponse {
  entries: CreditLedgerEntry[]
  error?: ApiErrorCode
}

const api = {
  // Auth
  login: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAuthStatus: (): Promise<AuthState> => ipcRenderer.invoke(IPC.AUTH_GET_STATUS),
  // La sesión murió y no se pudo renovar sola (refresh token ausente/inválido).
  // El renderer muestra el modal de "Tu sesión expiró".
  onSessionExpired: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC.AUTH_SESSION_EXPIRED, handler)
    return () => ipcRenderer.removeListener(IPC.AUTH_SESSION_EXPIRED, handler)
  },

  // Agent
  sendPrompt: (payload: { prompt: string; sessionId?: string; conversationId?: string; cwd?: string; maxTurns?: number; maxBudgetUsd?: number; activeContextId?: string; conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; modelChoice?: ModelChoice }): Promise<{ started: boolean; error?: string; code?: string }> =>
    ipcRenderer.invoke(IPC.AGENT_SEND_PROMPT, payload),
  abortAgent: (conversationId?: string): Promise<void> => ipcRenderer.invoke(IPC.AGENT_ABORT, conversationId),
  resetSession: (conversationId?: string): Promise<void> => ipcRenderer.invoke(IPC.AGENT_RESET_SESSION, conversationId),
  setPlanMode: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.AGENT_SET_PLAN_MODE, enabled),
  getPlanMode: (): Promise<boolean> => ipcRenderer.invoke(IPC.AGENT_GET_PLAN_MODE),

  // Files
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.SELECT_FOLDER),
  selectAttachments: (): Promise<AttachmentFile[]> => ipcRenderer.invoke(IPC.SELECT_ATTACHMENTS),
  // Ruta real en disco de un File del navegador (drag&drop) — Electron 32+ ya no expone
  // File.path directamente por seguridad; este es el reemplazo oficial documentado para
  // usar vía contextBridge.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Dictado por voz (Ola 1) — el renderer manda los bytes crudos (no tiene el Bearer).
  transcribeDictation: (buffer: ArrayBuffer, mimeType: string): Promise<DictationTranscribeResult> =>
    ipcRenderer.invoke(IPC.DICTATION_TRANSCRIBE, { buffer, mimeType }),

  // ask_user_question: listener for incoming questions + sender for user answers.
  // Both carry conversationId so each conversation routes to its own widget.
  onAskUserQuestion: (callback: (questions: AskUserQuestionItem[], conversationId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { conversationId: string; questions: AskUserQuestionItem[] }): void =>
      callback(data.questions, data.conversationId)
    ipcRenderer.on(IPC.AGENT_ASK_USER_QUESTION, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_ASK_USER_QUESTION, handler)
  },
  submitUserAnswers: (conversationId: string, answers: UserAnswerPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT_USER_ANSWER, { conversationId, answers }),

  // Cortafuegos de cotización: estado en vivo (reserva/commit/rollback)
  onQuoteFirewallEvent: (callback: (event: QuoteFirewallEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: QuoteFirewallEvent): void => callback(data)
    ipcRenderer.on(IPC.QUOTE_FIREWALL_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.QUOTE_FIREWALL_EVENT, handler)
  },

  // Lienzo HTML del agente — registra el HTML en el Map del proceso main y
  // devuelve el id que sirve `cerp-canvas://<id>` (ver canvasProtocol.ts en
  // main). null si el HTML viene vacío o supera el tope de registro.
  registerCanvasHtml: (html: string): Promise<string | null> => ipcRenderer.invoke(IPC.CANVAS_REGISTER, html),

  // Abre el lienzo en el navegador por defecto del sistema (útil para imprimir) —
  // el main escribe el HTML a un archivo temporal con la CSP del lienzo inyectada
  // como meta tag (ver canvasProtocol.ts) y lo abre con shell.openPath.
  openCanvasExternal: (canvasId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CANVAS_OPEN_EXTERNAL, canvasId),

  // Stream listeners — every event is tagged with the conversationId it belongs to.
  onAgentMessage: (callback: (event: AgentStreamEvent, conversationId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { conversationId: string; event: AgentStreamEvent }): void => callback(data.event, data.conversationId)
    ipcRenderer.on(IPC.AGENT_STREAM_MESSAGE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STREAM_MESSAGE, handler)
  },
  onAgentDone: (callback: (conversationId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { conversationId: string }): void => callback(data?.conversationId)
    ipcRenderer.on(IPC.AGENT_STREAM_DONE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STREAM_DONE, handler)
  },
  onAgentError: (callback: (err: { message: string; code?: string }, conversationId?: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { conversationId?: string; message: string; code?: string }): void => callback({ message: data.message, code: data.code }, data.conversationId)
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
  listConversations: (page?: number, limit?: number): Promise<{
    data: ConversationSummary[]
    pagination: { currentPage: number; totalPages: number; totalItems: number }
    error?: ApiErrorCode
  }> => ipcRenderer.invoke(IPC.CONVERSATION_LIST, { page, limit }),
  getConversation: (id: string): Promise<{ data: ConversationFull | null; error?: ApiErrorCode }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GET, id),
  createConversation: (data: { title: string; agentName: string; sessionId?: string; activeContextId?: string; metadata?: Record<string, unknown> }): Promise<any> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, data),
  appendConversationMessage: (conversationId: string, message: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_APPEND_MESSAGE, { conversationId, message, metadata }),
  deleteConversation: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),

  // Quotes
  getQuoteEligibility: (): Promise<{
    canQuote: boolean
    freeAvailable: boolean
    freeSource: 'trial_free' | 'monthly_free' | null
    priceCents: number
    currency: string
    paidThisMonth: number
    prepaidCredits: number
    unlimited: boolean
    blockedReason?: 'no_subscription' | 'subscription_inactive'
  } | { error: ApiErrorCode } | null> => ipcRenderer.invoke(IPC.QUOTES_GET_ELIGIBILITY),
  consumeUnlimitedQuote: (): Promise<{ quote: Record<string, unknown> } | null> =>
    ipcRenderer.invoke(IPC.QUOTES_CONSUME_UNLIMITED),
  listQuotes: (page?: number, pageSize?: number): Promise<{
    items: Array<Record<string, unknown>>
    page: number
    pageSize: number
    total: number
    error?: ApiErrorCode
  }> => ipcRenderer.invoke(IPC.QUOTES_LIST, { page, pageSize }),

  // Credits (Modelo CERP — créditos de IA)
  getCreditsBalance: (): Promise<CreditsBalance | null> => ipcRenderer.invoke(IPC.CREDITS_GET_BALANCE),
  getCreditsLedger: (limit?: number): Promise<CreditsLedgerResponse | null> => ipcRenderer.invoke(IPC.CREDITS_GET_LEDGER, { limit }),

  // Onboarding (Desktop guided tutorial — Idea 1)
  getOnboardingProgress: (): Promise<OnboardingProgressResponse> =>
    ipcRenderer.invoke(IPC.ONBOARDING_GET_PROGRESS),
  updateOnboardingProgress: (payload: OnboardingProgressUpdate): Promise<OnboardingProgressResponse> =>
    ipcRenderer.invoke(IPC.ONBOARDING_PATCH_PROGRESS, payload),

  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),

  // Auto-update
  onUpdateAvailable: (callback: (data: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { version: string }): void => callback(data)
    ipcRenderer.on(IPC.UPDATE_AVAILABLE, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, handler)
  },
  onUpdateDownloadProgress: (callback: (data: { percent: number }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { percent: number }): void => callback(data)
    ipcRenderer.on(IPC.UPDATE_DOWNLOAD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOAD_PROGRESS, handler)
  },
  onUpdateDownloaded: (callback: (data: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { version: string }): void => callback(data)
    ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler)
  },
  quitAndInstallUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATE_QUIT_AND_INSTALL),

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

  // Export conversation (Ola 3) — el renderer arma el Markdown, el main muestra el
  // diálogo nativo de guardado y escribe el archivo.
  exportConversationMarkdown: (defaultFileName: string, content: string): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.EXPORT_CONVERSATION, { defaultFileName, content }),
}

contextBridge.exposeInMainWorld('cerpAPI', api)
