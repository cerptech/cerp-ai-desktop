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
import { registerIpcHandlers } from './ipc/handlers'
import { initAutoUpdate } from './updater'
import { logger } from './utils/logger'
import { registerCanvasProtocolPrivileges, registerCanvasProtocolHandler } from './agent/canvasProtocol'

// Debe correr ANTES de que la app esté "ready" (requisito de Electron para
// protocol.registerSchemesAsPrivileged) — por eso va acá, a nivel de módulo,
// antes de cualquier lógica async. Sirve el lienzo HTML del agente
// (`cerp-canvas://<id>`) con su propia CSP por header; ver canvasProtocol.ts.
registerCanvasProtocolPrivileges()

let mainWindow: BrowserWindow | null = null

// Single instance lock — sigue siendo necesario para no abrir dos ventanas si el
// usuario lanza la app dos veces. El login usa un servidor HTTP local en vez del
// protocolo cerp-ai:// (ver auth0Client.ts), así que ya no hay nada que registrar
// como cliente de protocolo por defecto acá.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
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

    // Sirve los lienzos HTML del agente (cerp-canvas://<id>) — necesita la app
    // "ready" para que protocol.handle esté disponible.
    registerCanvasProtocolHandler()

    createWindow()

    // Al entrar a CERP IA: chequear si hay una versión nueva y descargarla.
    // No bloquea el arranque; el aviso de "reiniciá para actualizar" llega por IPC.
    initAutoUpdate(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

function createWindow(): void {
  // Ventana única (Ola 2): sin barra de título nativa — el header propio de
  // AppLayout hace de barra de arrastre. En Windows/Linux se superponen los
  // controles nativos (min/max/cerrar) sobre el header con `titleBarOverlay`;
  // en macOS se usa `hiddenInset`, que ya deja el semáforo flotando sobre
  // cualquier contenido sin necesitar overlay color.
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'CERP AI',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: '#fafafa',
            symbolColor: '#1e1e1e',
            height: 40,
          },
        }),
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
