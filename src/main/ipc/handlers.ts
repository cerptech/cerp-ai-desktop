import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from './channels'
import { login, logout, ensureFreshToken, refreshAccessToken, handleCallback } from '../auth/auth0Client'
import { tokenStore } from '../auth/tokenStore'
import { fetchApiKey, getApiKey, clearApiKey, NoCreditsError } from '../auth/apiKeyManager'
import { runAgent, interruptAgent, resetSession, setPlanMode, getPlanMode, setTurboMode, getTurboMode } from '../agent/agentManager'
import { quitAndInstallUpdate } from '../updater'
import { resolveAnswer } from '../agent/askUserBridge'
import { customAgentStore } from '../store/customAgentStore'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AuthState, UserAnswerPayload } from './types'
import type { CustomContext, CustomAgent } from '../store/types'

/** true si el error vino de una respuesta 401 — refresh ya se intentó y falló (ver onTokenExpired abajo). */
function isAuthError(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  function notifySessionExpired(): void {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AUTH_SESSION_EXPIRED)
    }
  }

  const httpClient = new HttpClient(
    () => tokenStore.getAccessToken(),
    async () => {
      logger.info('Token expirado durante la sesión — intentando renovar...')
      try {
        await refreshAccessToken()
        // El accessToken nuevo ya quedó guardado en tokenStore; fetchApiKey lo
        // usa automáticamente (vía el mismo httpClient) para re-validar la API key.
        await fetchApiKey(httpClient)
        logger.info('Token renovado y API key re-obtenida correctamente')
      } catch (err) {
        logger.warn('No se pudo renovar la sesión — limpiando credenciales:', err)
        tokenStore.clearAll()
        clearApiKey()
        notifySessionExpired()
        throw err
      }
    },
  )

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

  // Auth: Get status — refresca el token si está por vencer en vez de confiar
  // en que "existe" == "sirve" (isAuthenticated() antiguo no validaba expiración).
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async (): Promise<AuthState> => {
    const token = await ensureFreshToken()
    const user = tokenStore.getUser()
    return {
      isAuthenticated: !!token,
      user: token && user ? user : undefined,
    }
  })

  // Agent: Send prompt
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_PROMPT,
    async (_event, payload: SendPromptPayload): Promise<{ started: boolean; error?: string; code?: string }> => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return { started: false, error: 'No window' }

      let apiKey = getApiKey()
      if (!apiKey) {
        // Si no hay token utilizable (p.ej. el usuario cerró el modal de sesión
        // expirada sin volver a loguearse), cortamos acá: evita una llamada de
        // red condenada a fallar y devuelve el código correcto de una.
        const token = await ensureFreshToken()
        if (!token) {
          notifySessionExpired()
          return { started: false, error: 'No se pudo recuperar la sesión. Inicia sesión de nuevo.', code: 'AUTH_EXPIRED' }
        }

        try {
          const config = await fetchApiKey(httpClient)
          apiKey = config.apiKey
        } catch (err) {
          // Paywall (Modelo CERP): la empresa no tiene créditos — propagamos un código
          // distinguible para que el renderer muestre el banner de recarga en vez del
          // toast de error genérico.
          if (err instanceof NoCreditsError) {
            return { started: false, error: err.message, code: 'NO_CREDITS' }
          }
          // El httpClient ya intentó refrescar el token (onTokenExpired) antes de
          // llegar acá — si seguimos con 401 es porque el refresh falló y ya se
          // limpiaron las credenciales + se avisó al renderer (AUTH_SESSION_EXPIRED).
          // Devolvemos un código propio para que el chat NO muestre además un toast
          // rojo genérico encima del modal de sesión expirada.
          if (isAuthError(err)) {
            logger.warn('No se pudo obtener la API key: sesión expirada')
            return { started: false, error: 'No se pudo recuperar la sesión. Inicia sesión de nuevo.', code: 'AUTH_EXPIRED' }
          }
          logger.error('No se pudo obtener la API key:', err)
          return { started: false, error: 'No se pudo conectar con el servidor. Intenta de nuevo en unos segundos.', code: 'NETWORK_ERROR' }
        }
      }

      runAgent(payload, apiKey, 'claude-sonnet-4-6', httpClient, mainWindow).catch((err) => {
        logger.error('Agent run error:', err)
      })

      return { started: true }
    },
  )

  // Agent: Interrupt (graceful stop) — per conversation
  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, async (_event, conversationId?: string): Promise<void> => {
    await interruptAgent(conversationId)
  })

  // Agent: Reset session. With a conversationId → close that one; without → close all (logout).
  ipcMain.handle(IPC_CHANNELS.AGENT_RESET_SESSION, async (_event, conversationId?: string): Promise<void> => {
    resetSession(conversationId)
  })

  // Agent: Set plan mode
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_PLAN_MODE, async (_event, enabled: boolean): Promise<void> => {
    setPlanMode(enabled)
  })

  // Agent: Get plan mode (so the renderer can hydrate on startup)
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_PLAN_MODE, async (): Promise<boolean> => {
    return getPlanMode()
  })

  // Agent: Set turbo mode (Idea 3 — cotización exhaustiva)
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_TURBO_MODE, async (_event, enabled: boolean): Promise<void> => {
    setTurboMode(enabled)
  })

  // Agent: Get turbo mode (hydrate the toggle on startup)
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_TURBO_MODE, async (): Promise<boolean> => {
    return getTurboMode()
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
      // No fingir una lista vacía: el renderer distingue 'auth' (ya se disparó
      // el modal de sesión expirada, arriba) de 'network' (muestra error + reintentar).
      return { data: [], pagination: { currentPage: 1, totalPages: 0, totalItems: 0 }, error: isAuthError(err) ? 'auth' : 'network' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, async (_event, id: string) => {
    try {
      return await httpClient.get(`/desktop/conversations/${id}`)
    } catch (err) {
      logger.error(`Failed to get conversation ${id}:`, err)
      return { data: null, error: isAuthError(err) ? 'auth' : 'network' }
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
      // Antes esto devolvía null y el badge desaparecía sin avisar nada. Ahora
      // el renderer puede mostrar un estado de error con reintento en vez de
      // no mostrar nada (salvo 'auth', que ya dispara el modal global).
      return { error: isAuthError(err) ? 'auth' : 'network' } as const
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
      return { items: [], page: 1, pageSize: 20, total: 0, error: isAuthError(err) ? 'auth' : 'network' }
    }
  })

  // Credits: get balance (Modelo CERP — badge del header)
  ipcMain.handle(IPC_CHANNELS.CREDITS_GET_BALANCE, async () => {
    try {
      return await httpClient.get('/credits/balance')
    } catch (err) {
      logger.error('Failed to fetch credits balance:', err)
      return null
    }
  })

  // Credits: get ledger (extracto de movimientos — panel de historial)
  ipcMain.handle(IPC_CHANNELS.CREDITS_GET_LEDGER, async (_event, { limit }: { limit?: number } = {}) => {
    try {
      const qs = limit ? `?limit=${limit}` : ''
      return await httpClient.get(`/credits/ledger${qs}`)
    } catch (err) {
      logger.error('Failed to fetch credits ledger:', err)
      // Antes volvía null y el panel lo leía como "sin movimientos" (lista vacía
      // fingida). Ahora el panel puede mostrar su estado de error existente.
      return { entries: [], error: isAuthError(err) ? 'auth' : 'network' }
    }
  })

  // Onboarding: get Desktop guided-tutorial progress
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_GET_PROGRESS, async () => {
    try {
      return await httpClient.get('/onboarding/desktop-progress')
    } catch (err) {
      logger.error('Failed to fetch onboarding progress:', err)
      return null
    }
  })

  // Onboarding: update Desktop guided-tutorial progress
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_PATCH_PROGRESS, async (_event, payload: Record<string, unknown> = {}) => {
    try {
      return await httpClient.patch('/onboarding/desktop-progress', payload)
    } catch (err) {
      logger.error('Failed to update onboarding progress:', err)
      return null
    }
  })

  // ask_user_question: renderer sends back the user's answers (for a given conversation)
  ipcMain.handle(IPC_CHANNELS.AGENT_USER_ANSWER, async (_event, { conversationId, answers }: { conversationId?: string; answers: UserAnswerPayload }): Promise<void> => {
    resolveAnswer(conversationId || '__default__', answers)
  })

  // App: Get version
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => {
    const { app } = await import('electron')
    return app.getVersion()
  })

  // Auto-update: user accepted the "restart to update" prompt
  ipcMain.handle(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL, async (): Promise<void> => {
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
