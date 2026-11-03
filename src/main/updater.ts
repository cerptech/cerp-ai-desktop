import { autoUpdater, type CancellationToken } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc/channels'
import type { UpdateState, UpdateUnsupportedReason, UpdaterSnapshot } from './ipc/types'
import { blocksNewCheck, reduceUpdateState, stallTimeoutMs, type UpdaterEvent } from './updaterState'
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
// Estado: UNA sola fuente de verdad (`updaterState.ts`), empujada al renderer por
// UPDATE_STATE en cada cambio y pedible con UPDATE_GET_STATE al montar. La usan el
// aviso flotante, la sección «Actualizaciones» de Configuración y la pantalla de
// actualización obligatoria del chat.
//
// Cuándo se busca: al arrancar, cada PERIODIC_CHECK_INTERVAL_MS mientras la app siga
// abierta, a pedido del usuario y la primera vez que el core exige una versión más
// nueva. Nunca dos a la vez: un chequeo en curso, una descarga en curso o una
// versión ya lista bloquean el siguiente (`blocksNewCheck`).
//
// Ningún paso queda colgado, pero NO gracias a electron-updater: sus requests van por
// `net.request` de Electron, cuyo ClientRequest no emite 'socket', así que el timeout
// de 60 s de builder-util-runtime (que se arma en ese evento) nunca actúa. Una conexión
// estancada no daba ni 'error' ni rechazo, y con `blocksNewCheck` el estado quedaba en
// «Buscando…» o «Descargando 37 %» para siempre (y la pantalla obligatoria del chat sin
// salida). Lo cierra el watchdog de inactividad (`armWatchdog`, plazos en
// `stallTimeoutMs`): cancela la descarga con su CancellationToken y pasa a `error`.
//
// Plataformas del MVP: Windows (.exe NSIS) y Linux (AppImage). macOS queda
// bloqueado hasta firma + notarización (Gatekeeper rechaza updates sin firmar).

/**
 * Chequeo periódico mientras la app sigue abierta. Antes solo se buscaba al
 * arrancar, y un cliente que deja el Desktop abierto días enteros no se
 * actualizaba nunca.
 */
export const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60_000

let getWindow: (() => BrowserWindow | null) | null = null
let wired = false
let periodicTimer: ReturnType<typeof setInterval> | null = null
let state: UpdateState | null = null
let required = false
let seq = 0
let watchdog: ReturnType<typeof setTimeout> | null = null
/** Hay un checkForUpdates sin resolver. electron-updater lo guarda y lo devuelve en cada llamada hasta que se resuelva. */
let checkInFlight = false
/** Descarga en curso: su token (para cancelarla) y su promesa (electron-updater la devuelve mientras no termine). */
let downloadToken: CancellationToken | null = null
let downloadInFlight: Promise<unknown> | null = null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unsupportedReason(): UpdateUnsupportedReason | null {
  // En dev (no empaquetado) electron-updater no tiene app-update.yml y tira error.
  // No hay nada que actualizar corriendo desde el código fuente.
  if (!app.isPackaged) return 'dev'
  // macOS sin firma: electron-updater no puede aplicar el update (Gatekeeper).
  // Evitamos chequear para no spamear errores hasta que tengamos certificado Apple.
  if (process.platform === 'darwin') return 'macos'
  return null
}

function currentState(): UpdateState {
  if (!state) {
    const reason = unsupportedReason()
    state = reason ? { status: 'unsupported', reason } : { status: 'idle' }
  }
  return state
}

/** Foto del estado para el renderer (UPDATE_GET_STATE y cada UPDATE_STATE). */
export function getUpdaterSnapshot(): UpdaterSnapshot {
  return { state: currentState(), currentVersion: app.getVersion(), required, seq }
}

function publish(): void {
  seq++
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.UPDATE_STATE, getUpdaterSnapshot())
}

/**
 * Reprograma el watchdog con el estado resultante. Cualquier evento cuenta como
 * actividad, aunque no cambie el estado (un progreso que redondea al mismo %).
 */
function armWatchdog(s: UpdateState): void {
  if (watchdog) clearTimeout(watchdog)
  watchdog = null
  const ms = stallTimeoutMs(s)
  if (ms !== null) watchdog = setTimeout(onStall, ms)
}

function onStall(): void {
  watchdog = null
  const s = currentState()
  logger.warn(`[updater] Sin eventos del updater en estado ${s.status}: se da por trabado`)
  // Primero el estado: el rechazo por la cancelación llega después y ya no lo toca.
  dispatch({ type: 'stalled' })
  // En la descarga, cancelar rechaza su promesa y electron-updater la suelta (finally),
  // así «Reintentar» arranca una limpia. En el chequeo no hay token propio: la promesa
  // queda colgada dentro de electron-updater (ver runCheck).
  if (s.status === 'available' || s.status === 'downloading') downloadToken?.cancel()
}

function dispatch(event: UpdaterEvent): void {
  const prev = currentState()
  const next = reduceUpdateState(prev, event)
  armWatchdog(next)
  if (next === prev) return
  state = next
  publish()
}

function runCheck(reason: string): void {
  if (!wired) return
  const s = currentState()
  if (blocksNewCheck(s)) {
    logger.info(`[updater] Chequeo omitido (${reason}): estado ${s.status}`)
    return
  }
  if (checkInFlight) {
    // Solo pasa tras el watchdog: checkForUpdates devolvería la misma promesa colgada.
    logger.warn(`[updater] Chequeo omitido (${reason}): el anterior sigue sin responder`)
    dispatch({ type: 'stalled' })
    return
  }
  logger.info(`[updater] Buscando actualizaciones (${reason})...`)
  // El renderer ve «Buscando…» ya, sin esperar el evento de electron-updater.
  dispatch({ type: 'checking' })
  checkInFlight = true
  autoUpdater.checkForUpdates().then(
    (result) => {
      checkInFlight = false
      // null = updater inactivo. No debería pasar (solo se llega empaquetado), pero
      // sin esto el estado quedaría en «Buscando…» para siempre.
      if (!result) {
        dispatch({ type: 'check-skipped' })
        return
      }
      // Con autoDownload la descarga viaja en `downloadPromise`. Su fallo llega por el
      // evento 'error', salvo una cancelación (electron-updater no la emite): si la
      // descarga sigue abierta al rechazar, se cierra acá. Sin este catch, además, el
      // rechazo quedaba sin manejar en el main.
      const download = result.downloadPromise
      if (!download) return
      if (download === downloadInFlight) {
        // La descarga que el watchdog canceló no se soltó (la diferencial no escucha la
        // cancelación mientras no llegan datos): electron-updater devuelve la misma.
        logger.warn('[updater] La descarga anterior sigue colgada dentro de electron-updater')
        dispatch({ type: 'stalled' })
        return
      }
      downloadInFlight = download
      downloadToken = result.cancellationToken ?? null
      download
        .catch((err: unknown) => {
          const status = currentState().status
          if (status === 'available' || status === 'downloading') dispatch({ type: 'error', raw: errorMessage(err) })
        })
        .finally(() => {
          if (downloadInFlight !== download) return
          downloadInFlight = null
          downloadToken = null
        })
    },
    (err: unknown) => {
      checkInFlight = false
      logger.error(`[updater] checkForUpdates falló: ${errorMessage(err)}`)
      // El evento 'error' ya movió el estado; esto solo cubre que no hubiera llegado.
      if (currentState().status === 'checking') dispatch({ type: 'error', raw: errorMessage(err) })
    },
  )
}

/**
 * Cablea el auto-updater, dispara el primer chequeo y programa el periódico.
 * Idempotente: si ya se cableó, sólo re-dispara un chequeo.
 */
export function initAutoUpdate(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow

  const reason = unsupportedReason()
  if (reason) {
    logger.info(reason === 'dev' ? '[updater] Skipped — app no empaquetada (dev)' : '[updater] Skipped — macOS requiere firma + notarización (pendiente)')
    return
  }

  if (!wired) {
    autoUpdater.logger = logger as unknown as typeof autoUpdater.logger
    autoUpdater.autoDownload = true // descarga en background apenas hay versión nueva
    autoUpdater.autoInstallOnAppQuit = true // si el usuario no reinicia, se instala al cerrar

    autoUpdater.on('checking-for-update', () => {
      dispatch({ type: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      logger.info(`[updater] Nueva versión disponible: ${info.version} (descargando...)`)
      dispatch({ type: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      logger.info('[updater] App ya está en la última versión')
      dispatch({ type: 'not-available', at: Date.now() })
    })

    autoUpdater.on('download-progress', (p) => {
      dispatch({ type: 'progress', percent: p.percent })
    })

    autoUpdater.on('update-downloaded', (info) => {
      logger.info(`[updater] Versión ${info.version} descargada — lista para instalar`)
      dispatch({ type: 'downloaded', version: info.version })
    })

    autoUpdater.on('error', (err) => {
      // No es crítico: la app sigue funcionando con la versión actual.
      logger.error(`[updater] Error: ${errorMessage(err)}`)
      dispatch({ type: 'error', raw: errorMessage(err) })
    })

    wired = true
  }

  runCheck('al iniciar')

  if (!periodicTimer) {
    periodicTimer = setInterval(() => runCheck('periódico'), PERIODIC_CHECK_INTERVAL_MS)
  }
}

/**
 * «Buscar actualizaciones», «Actualizar ahora» y «Reintentar»: sin la espera de los
 * chequeos automáticos, pero sin duplicar un chequeo o una descarga en curso. Sin
 * efecto donde el auto-update está apagado (dev, macOS sin firma). Devuelve la foto
 * resultante.
 */
export function checkForUpdatesManual(): UpdaterSnapshot {
  runCheck('a pedido del usuario')
  return getUpdaterSnapshot()
}

/**
 * El core exige una versión más nueva (426 `DESKTOP_UPDATE_REQUIRED`, F0.2 (b)). Marca
 * la actualización como obligatoria (el chat muestra su pantalla) y, la PRIMERA vez en
 * esta ejecución, busca la versión nueva para que la descarga arranque sola. Los 426
 * siguientes (cada envío o refresco de la config puede volver a recibirlo) solo
 * quedan en el log: reintentar es del usuario o del chequeo periódico, así no hay
 * bucle de chequeos.
 */
export function notifyUpdateRequired(reason: string): void {
  if (required) {
    logger.info(`[updater] Versión mínima ya avisada (${reason})`)
    return
  }
  required = true
  logger.warn(`[updater] El core exige una versión más nueva (${reason})`)
  publish()
  runCheck(`el core exige una versión más nueva: ${reason}`)
}

/**
 * Reinicia la app e instala la actualización ya descargada.
 * Lo invoca el renderer cuando el usuario toca "Reiniciar e instalar".
 */
export function quitAndInstallUpdate(): void {
  if (currentState().status !== 'downloaded') {
    logger.warn(`[updater] quitAndInstall ignorado: no hay una versión descargada (estado ${currentState().status})`)
    return
  }
  logger.info('[updater] quitAndInstall solicitado por el usuario')
  // isSilent=false (muestra el instalador NSIS), isForceRunAfter=true (reabre la app)
  autoUpdater.quitAndInstall(false, true)
}
