import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import { login, logout, isAuthenticated, handleCallback } from '../auth/auth0Client'
import { tokenStore } from '../auth/tokenStore'
import { fetchApiKey, getApiKey } from '../auth/apiKeyManager'
import { runAgent, abortAgent, isAgentRunning } from '../agent/agentManager'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { SendPromptPayload, AuthState } from './types'

const httpClient = new HttpClient(() => tokenStore.getAccessToken())

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // Auth: Login
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (): Promise<AuthState> => {
    try {
      await login()
      // After login, fetch API key
      await fetchApiKey(httpClient)
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
      if (isAgentRunning()) return { started: false, error: 'Agent already running' }

      let apiKey = getApiKey()
      if (!apiKey) {
        try {
          const config = await fetchApiKey(httpClient)
          apiKey = config.apiKey
        } catch {
          return { started: false, error: 'Could not retrieve API key. Please log in again.' }
        }
      }

      // Fire and forget — streaming happens via webContents.send
      runAgent(payload, apiKey, 'claude-sonnet-4-6', httpClient, mainWindow).catch((err) => {
        logger.error('Agent run error:', err)
      })

      return { started: true }
    },
  )

  // Agent: Abort
  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, async (): Promise<void> => {
    abortAgent()
  })

  // App: Get version
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<string> => {
    const { app } = await import('electron')
    return app.getVersion()
  })
}

export { handleCallback }
