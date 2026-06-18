import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from './channels'
import { login, logout, isAuthenticated, handleCallback } from '../auth/auth0Client'
import { tokenStore } from '../auth/tokenStore'
import { fetchApiKey, getApiKey } from '../auth/apiKeyManager'
import { runAgent, interruptAgent, resetSession, setPlanMode, getPlanMode } from '../agent/agentManager'
import { resolveAnswer } from '../agent/askUserBridge'
import { customAgentStore } from '../store/customAgentStore'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AuthState, UserAnswerPayload } from './types'
import type { CustomContext, CustomAgent } from '../store/types'

const httpClient = new HttpClient(
  () => tokenStore.getAccessToken(),
  async () => {
    // On 401, try to refresh the API key (which re-validates the token)
    logger.info('Token expired during session, refreshing...')
    await fetchApiKey(httpClient)
  },
)

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // Auth: Login
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (): Promise<AuthState> => {
    try {
      await login()
      logger.info('Auth0 login completed, user authenticated')

      try {
        await fetchApiKey(httpClient)
        logger.info('API key fetched successfully')
      } catch (apiKeyErr) {
        logger.warn('Could not fetch API key (will retry later):', apiKeyErr)
      }

      const user = tokenStore.getUser()
      return { isAuthenticated: true, user: user || undefined }
    } catch (err) {
      logger.error('Login failed:', err)
      return { isAuthenticated: false }
    }
  })

  // Auth: Logout
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (): Promise<void> => {
    logout()
    resetSession()
  })

  // Auth: Get status
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async (): Promise<AuthState> => {
    const authenticated = isAuthenticated()
    const user = tokenStore.getUser()
    return {
      isAuthenticated: authenticated,
      user: authenticated && user ? user : undefined,
    }
  })

  // Agent: Send prompt
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_PROMPT,
    async (_event, payload: SendPromptPayload): Promise<{ started: boolean; error?: string }> => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return { started: false, error: 'No window' }

      let apiKey = getApiKey()
      if (!apiKey) {
        try {
          const config = await fetchApiKey(httpClient)
          apiKey = config.apiKey
        } catch {
          return { started: false, error: 'Could not retrieve API key. Please log in again.' }
        }
      }

      runAgent(payload, apiKey, 'claude-sonnet-4-6', httpClient, mainWindow).catch((err) => {
        logger.error('Agent run error:', err)
      })

      return { started: true }
    },
  )

  // Agent: Interrupt (graceful stop)
  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, async (): Promise<void> => {
    await interruptAgent()
  })

  // Agent: Reset session (new conversation)
  ipcMain.handle(IPC_CHANNELS.AGENT_RESET_SESSION, async (): Promise<void> => {
    resetSession()
  })

  // Agent: Set plan mode
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_PLAN_MODE, async (_event, enabled: boolean): Promise<void> => {
    setPlanMode(enabled)
  })

  // Agent: Get plan mode (so the renderer can hydrate on startup)
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_PLAN_MODE, async (): Promise<boolean> => {
    return getPlanMode()
  })

  // Dialog: Select PDF file
  ipcMain.handle(IPC_CHANNELS.SELECT_PDF, async (): Promise<string | null> => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Seleccionar PDF para adjuntar',
      filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }],
    })

    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Dialog: Select folder
  ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async (): Promise<string | null> => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Seleccionar carpeta de trabajo',
    })

    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // ── Custom Contexts CRUD ──

  ipcMain.handle(IPC_CHANNELS.CUSTOM_CONTEXTS_LIST, async () => {
    return customAgentStore.getContexts()
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_CONTEXT_CREATE, async (_event, ctx: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>) => {
    return customAgentStore.createContext(ctx)
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_CONTEXT_UPDATE, async (_event, { id, updates }: { id: string; updates: Partial<CustomContext> }) => {
    return customAgentStore.updateContext(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_CONTEXT_DELETE, async (_event, id: string) => {
    return customAgentStore.deleteContext(id)
  })

  // ── Custom Agents CRUD ──

  ipcMain.handle(IPC_CHANNELS.CUSTOM_AGENTS_LIST, async () => {
    return customAgentStore.getAgents()
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_AGENT_CREATE, async (_event, agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    return customAgentStore.createAgent(agent)
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_AGENT_UPDATE, async (_event, { id, updates }: { id: string; updates: Partial<CustomAgent> }) => {
    return customAgentStore.updateAgent(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_AGENT_DELETE, async (_event, id: string) => {
    return customAgentStore.deleteAgent(id)
  })

  // ── Conversations ──

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, async (_event, { page, limit }: { page?: number; limit?: number } = {}) => {
    try {
      return await httpClient.get(`/desktop/conversations?page=${page || 1}&limit=${limit || 20}`)
    } catch (err) {
      logger.error('Failed to list conversations:', err)
      return { data: [], pagination: { currentPage: 1, totalPages: 0, totalItems: 0 } }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, async (_event, id: string) => {
    try {
      return await httpClient.get(`/desktop/conversations/${id}`)
    } catch (err) {
      logger.error(`Failed to get conversation ${id}:`, err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE, async (_event, data: { title: string; agentName: string; sessionId?: string; activeContextId?: string; metadata?: Record<string, unknown> }) => {
    try {
      return await httpClient.post('/desktop/conversations', data)
    } catch (err) {
      logger.error('Failed to create conversation:', err)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_APPEND_MESSAGE, async (_event, { conversationId, message, metadata }: { conversationId: string; message: Record<string, unknown>; metadata?: Record<string, unknown> }) => {
    try {
      await httpClient.post(`/desktop/conversations/${conversationId}/messages`, { message, metadata })
      return true
    } catch (err) {
      logger.error(`Failed to append message to ${conversationId}:`, err)
      return false
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, async (_event, id: string) => {
    try {
      await httpClient.delete(`/desktop/conversations/${id}`)
      return true
    } catch (err) {
      logger.error(`Failed to delete conversation ${id}:`, err)
      return false
    }
  })

  // Quotes: get eligibility (for status badge)
  ipcMain.handle(IPC_CHANNELS.QUOTES_GET_ELIGIBILITY, async () => {
    try {
      return await httpClient.get('/quotes/eligibility')
    } catch (err) {
      logger.error('Failed to fetch quote eligibility:', err)
      return null
    }
  })

  // Quotes: consume-unlimited (CERP IA Ilimitado add-on)
  ipcMain.handle(IPC_CHANNELS.QUOTES_CONSUME_UNLIMITED, async () => {
    try {
      return await httpClient.post('/quotes/consume-unlimited', {})
    } catch (err) {
      logger.error('Failed to consume unlimited quote:', err)
      return null
    }
  })

  // Quotes: list (for history)
  ipcMain.handle(IPC_CHANNELS.QUOTES_LIST, async (_event, { page, pageSize }: { page?: number; pageSize?: number } = {}) => {
    try {
      const qs = new URLSearchParams()
      if (page) qs.set('page', String(page))
      if (pageSize) qs.set('pageSize', String(pageSize))
      const path = qs.toString() ? `/quotes?${qs}` : '/quotes'
      return await httpClient.get(path)
    } catch (err) {
      logger.error('Failed to list quotes:', err)
      return { items: [], page: 1, pageSize: 20, total: 0 }
    }
  })

  // ask_user_question: renderer sends back the user's answers
  ipcMain.handle(IPC_CHANNELS.AGENT_USER_ANSWER, async (_event, answers: UserAnswerPayload): Promise<void> => {
    resolveAnswer(answers)
  })

  // App: Get version
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => {
    const { app } = await import('electron')
    return app.getVersion()
  })

  // Auto-update: user accepted the "restart to update" prompt
  ipcMain.handle(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL, async (): Promise<void> => {
    const { quitAndInstallUpdate } = await import('../updater')
    quitAndInstallUpdate()
  })

  // Python: Check
  ipcMain.handle(IPC_CHANNELS.PYTHON_CHECK, async () => {
    const { checkPython } = await import('../utils/pythonSetup')
    return checkPython()
  })

  // Python: Install
  ipcMain.handle(IPC_CHANNELS.PYTHON_INSTALL, async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return false
    const { installPython } = await import('../utils/pythonSetup')
    return installPython(mainWindow, (message, percent) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.PYTHON_INSTALL_PROGRESS, { message, percent })
      }
    })
  })

  // Git: Check
  ipcMain.handle(IPC_CHANNELS.GIT_CHECK, async () => {
    const { checkGit } = await import('../utils/pythonSetup')
    return checkGit()
  })

  // Git: Install
  ipcMain.handle(IPC_CHANNELS.GIT_INSTALL, async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return false
    const { installGit } = await import('../utils/pythonSetup')
    return installGit((message, percent) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.GIT_INSTALL_PROGRESS, { message, percent })
      }
    })
  })
}

export { handleCallback }
