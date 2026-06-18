export const IPC_CHANNELS = {
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATUS: 'auth:get-status',

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
  SELECT_PDF: 'dialog:select-pdf',

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

  // Plan Mode
  AGENT_SET_PLAN_MODE: 'agent:set-plan-mode',
  AGENT_GET_PLAN_MODE: 'agent:get-plan-mode',

  // ask_user_question tool — structured clarification widget
  AGENT_ASK_USER_QUESTION: 'agent:ask_user_question',
  AGENT_USER_ANSWER: 'agent:user_answer',

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
