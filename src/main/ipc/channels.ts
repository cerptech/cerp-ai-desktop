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

  // App
  APP_GET_VERSION: 'app:get-version',
} as const
