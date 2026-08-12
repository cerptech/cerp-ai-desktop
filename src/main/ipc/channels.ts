export const IPC_CHANNELS = {
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATUS: 'auth:get-status',
  // main → renderer: la sesión murió (refresh token ausente o inválido) y no
  // se pudo renovar sola. El renderer muestra el modal de sesión expirada.
  AUTH_SESSION_EXPIRED: 'auth:session-expired',

  // Agent
  AGENT_SEND_PROMPT: 'agent:send-prompt',
  AGENT_ABORT: 'agent:abort',
  AGENT_RESET_SESSION: 'agent:reset-session',

  // Agent stream events (main → renderer)
  AGENT_STREAM_MESSAGE: 'agent:stream:message',
  AGENT_STREAM_DONE: 'agent:stream:done',
  AGENT_STREAM_ERROR: 'agent:stream:error',

  // Files
  SELECT_FOLDER: 'dialog:select-folder',
  // Ola 1 — reemplaza al viejo SELECT_PDF (un solo PDF): multiselección + más tipos.
  SELECT_ATTACHMENTS: 'dialog:select-attachments',
  // Ola 3 — exporta una conversación a Markdown (dialog:showSaveDialog + escritura).
  EXPORT_CONVERSATION: 'dialog:export-conversation',

  // Dictado por voz (Ola 1) — el renderer manda los bytes crudos, el main hace el
  // POST multipart con el Bearer (el renderer no tiene el token).
  DICTATION_TRANSCRIBE: 'dictation:transcribe',

  // Custom agents/contexts
  CUSTOM_CONTEXTS_LIST: 'custom:contexts:list',
  CUSTOM_CONTEXT_CREATE: 'custom:context:create',
  CUSTOM_CONTEXT_UPDATE: 'custom:context:update',
  CUSTOM_CONTEXT_DELETE: 'custom:context:delete',
  CUSTOM_AGENTS_LIST: 'custom:agents:list',
  CUSTOM_AGENT_CREATE: 'custom:agent:create',
  CUSTOM_AGENT_UPDATE: 'custom:agent:update',
  CUSTOM_AGENT_DELETE: 'custom:agent:delete',

  // Conversations
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_APPEND_MESSAGE: 'conversation:append-message',
  CONVERSATION_DELETE: 'conversation:delete',

  // Quotes (cerp-ai-desktop monetization)
  QUOTES_GET_ELIGIBILITY: 'quotes:get-eligibility',
  QUOTES_LIST: 'quotes:list',
  QUOTES_CONSUME_UNLIMITED: 'quotes:consume-unlimited',

  // Credits (Modelo CERP — créditos de IA)
  CREDITS_GET_BALANCE: 'credits:get-balance',
  CREDITS_GET_LEDGER: 'credits:get-ledger',

  // Onboarding (Desktop guided tutorial — Idea 1)
  ONBOARDING_GET_PROGRESS: 'onboarding:get-progress',
  ONBOARDING_PATCH_PROGRESS: 'onboarding:patch-progress',

  // Plan Mode
  AGENT_SET_PLAN_MODE: 'agent:set-plan-mode',
  AGENT_GET_PLAN_MODE: 'agent:get-plan-mode',

  // ask_user_question tool — structured clarification widget
  AGENT_ASK_USER_QUESTION: 'agent:ask_user_question',
  AGENT_USER_ANSWER: 'agent:user_answer',

  // Cortafuegos de cotización (Idea 2) — eventos de estado main → renderer
  QUOTE_FIREWALL_EVENT: 'quote:firewall:event',

  // Lienzo HTML del agente — registra el HTML en el Map del main y devuelve el
  // id que sirve el protocolo cerp-canvas:// (ver canvasProtocol.ts).
  CANVAS_REGISTER: 'canvas:register',
  // Escribe el lienzo a un archivo temporal (con la CSP como meta tag) y lo abre
  // con la app por defecto del sistema — útil para imprimir.
  CANVAS_OPEN_EXTERNAL: 'canvas:open-external',

  // App
  APP_GET_VERSION: 'app:get-version',

  // Auto-update (main → renderer events + renderer → main action)
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_DOWNLOAD_PROGRESS: 'update:download-progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_QUIT_AND_INSTALL: 'update:quit-and-install',

  // Setup (Python + Git)
  PYTHON_CHECK: 'python:check',
  PYTHON_INSTALL: 'python:install',
  PYTHON_INSTALL_PROGRESS: 'python:install:progress',
  GIT_CHECK: 'git:check',
  GIT_INSTALL: 'git:install',
  GIT_INSTALL_PROGRESS: 'git:install:progress',
} as const
