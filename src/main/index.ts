import { config } from 'dotenv'
import { resolve, dirname } from 'path'

// Load .env — try multiple locations (dev: cwd, prod: next to executable, prod: app resources)
config({ path: resolve(process.cwd(), '.env') })
config({ path: resolve(dirname(process.execPath), '.env') })
config({ path: resolve(__dirname, '..', '.env') })

// Auth0 defaults — these are public client IDs, not secrets
if (!process.env.AUTH0_DOMAIN) process.env.AUTH0_DOMAIN = 'dev-dg6vz8aqjb8sy36a.us.auth0.com'
if (!process.env.AUTH0_CLIENT_ID) process.env.AUTH0_CLIENT_ID = 'VWC79LAXocZa4YgLXB9cLabqj1kHJWVb'
if (!process.env.AUTH0_AUDIENCE) process.env.AUTH0_AUDIENCE = 'https://api.cerp.es'

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers, handleCallback } from './ipc/handlers'
import { logger } from './utils/logger'

let mainWindow: BrowserWindow | null = null

// Register custom protocol for Auth0 callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('cerp-ai', process.execPath, [process.argv[1]])
  }
} else {
  app.setAsDefaultProtocolClient('cerp-ai')
}

// Single instance lock — required for custom protocol on Windows
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Handle cerp-ai:// protocol from second instance
    const url = commandLine.find((arg) => arg.startsWith('cerp-ai://'))
    if (url) {
      handleCallback(url)
    }

    // Focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    logger.info('CERP AI Desktop starting...')

    // Register IPC handlers
    registerIpcHandlers(() => mainWindow)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'CERP AI',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for Agent SDK child process spawning
    },
  })

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Handle cerp-ai:// on macOS
app.on('open-url', (_event, url) => {
  handleCallback(url)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
