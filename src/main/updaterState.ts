import type { UpdateErrorPhase, UpdateState } from './ipc/types'

// ============================================================
// Máquina de estados del auto-update (lógica pura)
// ============================================================
// updater.ts traduce cada evento de electron-updater a un `UpdaterEvent` y guarda lo
// que devuelve `reduceUpdateState`; el renderer solo recibe el resultado. Sin
// Electron acá para poder probarla aparte. Devolver el MISMO objeto significa "no
// cambió nada" (updater.ts no lo vuelve a empujar al renderer).

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; at: number }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  /** `raw`: mensaje crudo del error; el estado guarda el texto para el usuario. */
  | { type: 'error'; raw: string }
  /** checkForUpdates resolvió sin resultado (updater inactivo): el chequeo no ocurrió. */
  | { type: 'check-skipped' }
  /** El watchdog de updater.ts vio el chequeo o la descarga sin ningún evento durante `stallTimeoutMs`. */
  | { type: 'stalled' }

/**
 * Sin timeout HTTP propio: electron-updater hace las requests con `net.request` de
 * Electron, cuyo ClientRequest no emite 'socket', y el timeout de builder-util-runtime
 * (`addTimeOutHandler`) solo se arma en ese evento. Una conexión que se estanca sin
 * cerrarse (proxy, wifi degradado, suspensión) no termina nunca en 'error' ni en
 * rechazo, y `blocksNewCheck` dejaría el estado bloqueado para siempre. Estos plazos
 * son la ausencia de CUALQUIER evento del updater, no la duración total: la consulta a
 * GitHub tarda segundos y la descarga emite progreso cada segundo mientras avanza.
 */
export const CHECK_STALL_TIMEOUT_MS = 2 * 60_000
export const DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60_000

/** Plazo sin eventos tras el cual el estado se da por trabado; null si el estado no espera nada del updater. */
export function stallTimeoutMs(state: UpdateState): number | null {
  if (state.status === 'checking') return CHECK_STALL_TIMEOUT_MS
  if (state.status === 'available' || state.status === 'downloading') return DOWNLOAD_STALL_TIMEOUT_MS
  return null
}

/**
 * Texto de un paso trabado. Reintentar suele alcanzar en la descarga (se cancela y
 * arranca limpia); en el chequeo no, porque electron-updater guarda la promesa colgada
 * y la devuelve en cada checkForUpdates hasta reiniciar.
 */
export function stalledUpdateMessage(phase: UpdateErrorPhase): string {
  return phase === 'check'
    ? 'La búsqueda de actualizaciones no respondió. Cierra CERP IA Desktop y vuelve a abrirlo para volver a buscar.'
    : 'La descarga de la actualización se detuvo. Reintenta; si vuelve a pasar, cierra CERP IA Desktop y vuelve a abrirlo.'
}

/**
 * true si NO hay que lanzar otro chequeo: ya hay uno en curso, la versión nueva se
 * está bajando (`available` = la descarga automática ya arrancó), ya está lista para
 * instalar, o esta copia no se actualiza sola.
 */
export function blocksNewCheck(state: UpdateState): boolean {
  return (
    state.status === 'unsupported' ||
    state.status === 'checking' ||
    state.status === 'available' ||
    state.status === 'downloading' ||
    state.status === 'downloaded'
  )
}

// Errores de red de Node/Electron (DNS, conexión rechazada o cortada, timeouts,
// errores net:: de Chromium, que es quien hace las requests en Electron).
const NETWORK_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|net::ERR_|getaddrinfo|timeout/i

/** Texto para el usuario según el paso que falló. El mensaje crudo queda solo en el log. */
export function friendlyUpdateError(raw: string, phase: UpdateErrorPhase): string {
  const network = NETWORK_ERROR.test(raw)
  if (phase === 'install') {
    return 'No se pudo abrir el instalador. Cierra CERP IA Desktop y vuelve a abrirlo para instalar la actualización.'
  }
  if (phase === 'download') {
    return network
      ? 'Se cortó la descarga de la actualización. Revisa tu conexión a internet.'
      : 'No se pudo descargar la actualización.'
  }
  return network
    ? 'No se pudo conectar para buscar actualizaciones. Revisa tu conexión a internet.'
    : 'No se pudo comprobar si hay una versión nueva. Inténtalo de nuevo en unos minutos.'
}

export function reduceUpdateState(state: UpdateState, event: UpdaterEvent): UpdateState {
  // Dev o macOS sin firma: no hay updater cableado, ningún evento lo saca de acá.
  if (state.status === 'unsupported') return state

  switch (event.type) {
    case 'checking':
      // Un chequeo nunca pisa una descarga en curso ni una versión ya lista.
      if (state.status === 'checking' || state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') return state
      return { status: 'checking' }

    case 'available':
      // electron-updater vuelve a avisar la misma versión si se re-chequea mientras baja.
      if ((state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') && state.version === event.version) return state
      return { status: 'available', version: event.version }

    case 'not-available':
      if (state.status === 'downloading' || state.status === 'downloaded') return state
      return { status: 'not-available', checkedAt: event.at }

    case 'progress': {
      if (state.status === 'downloaded') return state
      const percent = Math.min(100, Math.max(0, Math.round(Number.isFinite(event.percent) ? event.percent : 0)))
      if (state.status === 'downloading' && state.percent === percent) return state
      const version = state.status === 'available' || state.status === 'downloading' ? state.version : ''
      return { status: 'downloading', version, percent }
    }

    case 'downloaded':
      if (state.status === 'downloaded' && state.version === event.version) return state
      return { status: 'downloaded', version: event.version }

    case 'error': {
      // El paso que falló sale del estado previo: con la versión ya encontrada, falló la
      // descarga; con la descarga lista, el instalador (quitAndInstall).
      const phase: UpdateErrorPhase =
        state.status === 'available' || state.status === 'downloading'
          ? 'download'
          : state.status === 'downloaded'
            ? 'install'
            : 'check'
      return { status: 'error', phase, message: friendlyUpdateError(event.raw, phase) }
    }

    case 'check-skipped':
      return state.status === 'checking' ? { status: 'idle' } : state

    case 'stalled': {
      // Desde `error` llega cuando el usuario reintenta sobre un paso que sigue colgado
      // dentro de electron-updater: se conserva la fase y se vuelve a publicar.
      if (state.status !== 'checking' && state.status !== 'available' && state.status !== 'downloading' && state.status !== 'error') return state
      const phase: UpdateErrorPhase = state.status === 'checking' ? 'check' : state.status === 'error' ? state.phase : 'download'
      return { status: 'error', phase, message: stalledUpdateMessage(phase) }
    }
  }
}
