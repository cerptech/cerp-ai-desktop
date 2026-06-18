import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc/channels'
import { logger } from './utils/logger'

// ============================================================
// Auto-update (electron-updater + GitHub Releases)
// ============================================================
// El repo cerptech/cerp-ai-desktop es PÚBLICO y cada Release publica
// latest.yml / latest-linux.yml + installers + .blockmap, así que el provider
// `github` de electron-builder.yml funciona sin token.
//
// UX (decisión de producto 2026-06-18): descarga automática en segundo plano;
// cuando la nueva versión está lista mostramos un aviso discreto en el renderer
// ("reiniciá para actualizar"). El usuario elige cuándo reiniciar; si no, se
// instala sola al cerrar la app (autoInstallOnAppQuit).
//
// Plataformas del MVP: Windows (.exe NSIS) y Linux (AppImage). macOS queda
// bloqueado hasta firma + notarización (Gatekeeper rechaza updates sin firmar).

let mainWindowRef: BrowserWindow | null = null
let wired = false

function send(channel: string, payload?: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload)
  }
}

/**
 * Cablea el auto-updater y dispara el primer chequeo.
 * Idempotente: si ya se cableó, sólo re-dispara un chequeo.
 */
export function initAutoUpdate(getMainWindow: () => BrowserWindow | null): void {
  mainWindowRef = getMainWindow()

  // En dev (no empaquetado) electron-updater no tiene app-update.yml y tira error.
  // No hay nada que actualizar corriendo desde el código fuente.
  if (!app.isPackaged) {
    logger.info('[updater] Skipped — app no empaquetada (dev)')
    return
  }

  // macOS sin firma: electron-updater no puede aplicar el update (Gatekeeper).
  // Evitamos chequear para no spamear errores hasta que tengamos certificado Apple.
  if (process.platform === 'darwin') {
    logger.info('[updater] Skipped — macOS requiere firma + notarización (pendiente)')
    return
  }

  if (!wired) {
    autoUpdater.logger = logger as unknown as typeof autoUpdater.logger
    autoUpdater.autoDownload = true // descarga en background apenas hay versión nueva
    autoUpdater.autoInstallOnAppQuit = true // si el usuario no reinicia, se instala al cerrar

    autoUpdater.on('checking-for-update', () => {
      logger.info('[updater] Buscando actualizaciones...')
    })

    autoUpdater.on('update-available', (info) => {
      logger.info(`[updater] Nueva versión disponible: ${info.version} (descargando...)`)
      send(IPC_CHANNELS.UPDATE_AVAILABLE, { version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      logger.info('[updater] App ya está en la última versión')
    })

    autoUpdater.on('download-progress', (p) => {
      send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, { percent: Math.round(p.percent) })
    })

    autoUpdater.on('update-downloaded', (info) => {
      logger.info(`[updater] Versión ${info.version} descargada — lista para instalar`)
      send(IPC_CHANNELS.UPDATE_DOWNLOADED, { version: info.version })
    })

    autoUpdater.on('error', (err) => {
      // No es crítico: la app sigue funcionando con la versión actual.
      logger.error(`[updater] Error: ${err instanceof Error ? err.message : String(err)}`)
    })

    wired = true
  }

  autoUpdater.checkForUpdates().catch((err) => {
    logger.error(`[updater] checkForUpdates falló: ${err instanceof Error ? err.message : String(err)}`)
  })
}

/**
 * Reinicia la app e instala la actualización ya descargada.
 * Lo invoca el renderer cuando el usuario toca "Reiniciar para actualizar".
 */
export function quitAndInstallUpdate(): void {
  logger.info('[updater] quitAndInstall solicitado por el usuario')
  // isSilent=false (muestra el instalador NSIS), isForceRunAfter=true (reabre la app)
  autoUpdater.quitAndInstall(false, true)
}
