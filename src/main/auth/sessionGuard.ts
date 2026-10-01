import {
  companyChangedMessage,
  isCompanyChangeApplied,
  NO_ACTIVE_COMPANY_MESSAGE,
  type SessionErrorInfo,
} from '../utils/sessionErrors'
import type { CompanyChangedNotice } from '../ipc/types'

/**
 * Reacción del Desktop a los errores de sesión/empresa del core (multi-empresa,
 * plan DK-1.1; contrato §7.7). El `HttpClient` los detecta y avisa acá sin esperar;
 * el request que los recibió ya lanzó su error tipado y NO se reintenta.
 *
 * Sin imports de Electron ni del store: todo efecto entra por `deps`, así la lógica
 * (deduplicado, orden de pasos, qué se avisa) se prueba sin levantar la app.
 */

export interface SessionGuardDeps {
  getCompanyId: () => string | null
  /** Tira la config cacheada y el `companyId` persistido. */
  invalidateCompanyConfig: () => void
  /** Vuelve a pedir `/desktop/api-key`; devuelve el `companyId` nuevo. */
  refetchCompanyId: () => Promise<string | null>
  /** Nombre de la empresa activa (best effort; `null` si no se pudo). */
  fetchCompanyName: () => Promise<string | null>
  /** Detiene los turnos del agente que corren con otra empresa y tira la caché del contexto. */
  stopStaleSessions: (companyId: string | null) => void
  notifyCompanyChanged: (notice: CompanyChangedNotice) => void
  /** Cierra la sesión (credenciales + sesiones del agente) y muestra el mensaje. */
  signOutNoCompany: (message: string) => void
  /** El camino de un 401 sin refresh posible: limpia credenciales y abre el modal de sesión expirada. */
  signOutSessionRevoked: () => void
  log: { info: (msg: string) => void; warn: (msg: string) => void }
  now?: () => number
  /** Topes de espera (ms) de los dos requests del cambio de empresa; los tests los acortan. */
  timeoutsMs?: { refetch?: number; companyName?: number }
}

/** Ventana en la que varios 403/401 concurrentes cuentan como UN solo cierre de sesión. */
const SIGN_OUT_DEDUPE_MS = 10_000

/**
 * El `HttpClient` no tiene timeout: sin tope, un `/desktop/api-key` o un `/users/me`
 * colgados dejarían `isApplyingCompanyChange()` en true para siempre y todo envío
 * quedaría retenido (recheck 2 de DK1). Pasado el tope el cambio se aplica igual:
 * el aviso sale sin nombre, o con la empresa que informó el 409.
 */
const REFETCH_TIMEOUT_MS = 15_000
const COMPANY_NAME_TIMEOUT_MS = 10_000

/**
 * Ventana en la que un aviso con destino desconocido (`null`: el refetch falló y el 409
 * no traía `activeCompanyId`), o justo después de uno así, cuenta como el MISMO cambio.
 */
export const COMPANY_NOTICE_COOLDOWN_MS = 60_000

/** El último aviso de cambio de empresa que se mostró. */
export interface LastCompanyNotice {
  companyId: string | null
  at: number
}

/**
 * true si un aviso hacia `target` repetiría el último (review de DK1, minor 2):
 * - el mismo destino conocido ya se avisó (hasta el próximo logout: `resetCompanyNotices`);
 * - dentro de la ventana, si alguno de los dos destinos es desconocido: con la config
 *   vacía tras un refetch fallido, cada tool vieja que choca con el 409 volvería a
 *   avisar. Dos destinos conocidos distintos (A → B → C) sí avisan dos veces.
 */
export function shouldSkipCompanyNotice(
  last: LastCompanyNotice | null,
  target: string | null,
  now: number,
  cooldownMs: number = COMPANY_NOTICE_COOLDOWN_MS,
): boolean {
  if (!last) return false
  if (target !== null && target === last.companyId) return true
  const withinCooldown = now - last.at < cooldownMs
  return withinCooldown && (target === null || last.companyId === null)
}

class GuardTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what}: sin respuesta en ${ms} ms`)
    this.name = 'GuardTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GuardTimeoutError(what, ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function errorCode(err: unknown): string | undefined {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/**
 * El guard: se llama con cada error de sesión que reporta el `HttpClient`, y con
 * `onCompanyObserved` cuando el refresco normal de `/desktop/api-key` (TTL, arranque
 * de sesión, login) trae otra empresa que la cacheada. Los dos caminos comparten el
 * deduplicado: un solo cambio de empresa da UN solo aviso.
 */
export interface SessionGuard {
  (info: SessionErrorInfo): Promise<void>
  /**
   * La config ya trae `next` (antes `previous`) sin que haya llegado un 409: el
   * re-homing pasa a cualquier hora y el refresco de la config suele verlo antes que
   * una tool. Detiene los turnos con la empresa vieja y tira el contexto de empresa
   * cacheado de forma SÍNCRONA (antes del primer `await`), y avisa al usuario.
   */
  onCompanyObserved: (previous: string | null, next: string | null) => Promise<void>
  /**
   * true mientras un cambio de empresa se está aplicando (refetch tras un 409, o el
   * aviso todavía en camino). El envío de un prompt no arranca un turno en ese lapso:
   * correría en la empresa nueva antes de que el usuario vea el aviso.
   */
  isApplyingCompanyChange: () => boolean
  /**
   * Olvida el último aviso de cambio de empresa (recheck 1 de DK1). Va en cada cierre de
   * sesión (logout, cuenta sin empresa, sesión revocada, refresh fallido): la próxima
   * cuenta que entre, o la misma, tiene que ver su propio aviso aunque el destino coincida.
   */
  resetCompanyNotices: () => void
}

export function createSessionGuard(deps: SessionGuardDeps): SessionGuard {
  const now = deps.now ?? Date.now
  const refetchTimeoutMs = deps.timeoutsMs?.refetch ?? REFETCH_TIMEOUT_MS
  const companyNameTimeoutMs = deps.timeoutsMs?.companyName ?? COMPANY_NAME_TIMEOUT_MS
  let companyChange: Promise<void> | null = null
  /** Último aviso mostrado: un 409 tardío de una sesión vieja no lo repite. */
  let lastNotice: LastCompanyNotice | null = null
  let lastNoCompanySignOut = Number.NEGATIVE_INFINITY
  let lastRevokedSignOut = Number.NEGATIVE_INFINITY

  function resetCompanyNotices(): void {
    lastNotice = null
  }

  async function notifyChange(companyId: string | null): Promise<void> {
    if (shouldSkipCompanyNotice(lastNotice, companyId, now())) {
      deps.log.info(`[session] Cambio a ${companyId ?? '(empresa desconocida)'} ya avisado — no se repite el aviso`)
      return
    }
    lastNotice = { companyId, at: now() }
    let companyName: string | null = null
    try {
      companyName = await withTimeout(deps.fetchCompanyName(), companyNameTimeoutMs, 'GET /users/me')
    } catch (err) {
      // El aviso sale sin nombre.
      if (err instanceof GuardTimeoutError) deps.log.warn(`[session] ${err.message} — el aviso sale sin nombre`)
    }
    deps.notifyCompanyChanged({ companyId, companyName, message: companyChangedMessage(companyName) })
  }

  async function runCompanyChange(info: SessionErrorInfo): Promise<void> {
    const previous = deps.getCompanyId()
    deps.log.warn(`[session] 409 COMPANY_CHANGED: la empresa por defecto cambió (antes ${previous ?? '-'}, ahora ${info.activeCompanyId ?? '?'})`)
    deps.invalidateCompanyConfig()

    let companyId = info.activeCompanyId
    try {
      companyId = (await withTimeout(deps.refetchCompanyId(), refetchTimeoutMs, 'POST /desktop/api-key')) ?? companyId
    } catch (err) {
      const code = errorCode(err)
      // Sin empresa o sesión revocada: el propio refetch ya disparó ESE manejo
      // (cierre de sesión). Un aviso de "cambió tu empresa" encima sobra.
      if (code === 'NO_ACTIVE_COMPANY' || code === 'SESSION_REVOKED') {
        deps.stopStaleSessions(null)
        return
      }
      deps.log.warn(`[session] No se pudo volver a pedir la config tras COMPANY_CHANGED: ${err instanceof Error ? err.message : String(err)}`)
    }

    deps.stopStaleSessions(companyId)
    await notifyChange(companyId)
  }

  async function runObservedChange(previous: string, next: string): Promise<void> {
    deps.log.warn(`[session] La config trajo otra empresa por defecto (antes ${previous}, ahora ${next})`)
    // Síncrono, antes del primer await: el caller de fetchApiKey puede arrancar una
    // sesión con la empresa nueva apenas vuelve, y no debe reusar el contexto viejo.
    deps.stopStaleSessions(next)
    await notifyChange(next)
  }

  function track(change: Promise<void>): Promise<void> {
    companyChange = change.finally(() => {
      companyChange = null
    })
    return companyChange
  }

  const handleSessionError = async function handleSessionError(info: SessionErrorInfo): Promise<void> {
    if (info.kind === 'company_changed') {
      // Tools de una sesión vieja que siguen chocando con el 409 después de aplicar el cambio
      // (por este camino o porque el refresco de la config ya lo trajo).
      if (isCompanyChangeApplied(info, deps.getCompanyId())) return
      // Varias tools concurrentes: un solo refetch y un solo aviso.
      if (companyChange) return companyChange
      return track(runCompanyChange(info))
    }

    if (info.kind === 'no_active_company') {
      if (now() - lastNoCompanySignOut < SIGN_OUT_DEDUPE_MS) return
      lastNoCompanySignOut = now()
      deps.log.warn('[session] 403 NO_ACTIVE_COMPANY: la cuenta no tiene empresas activas — se cierra la sesión')
      deps.signOutNoCompany(NO_ACTIVE_COMPANY_MESSAGE)
      resetCompanyNotices()
      return
    }

    if (now() - lastRevokedSignOut < SIGN_OUT_DEDUPE_MS) return
    lastRevokedSignOut = now()
    deps.log.warn('[session] 401 SESSION_REVOKED después del refresh — la sesión se cerró por seguridad')
    deps.signOutSessionRevoked()
    resetCompanyNotices()
  }

  function onCompanyObserved(previous: string | null, next: string | null): Promise<void> {
    if (!previous || !next || previous === next) return Promise.resolve()
    // Un 409 ya está aplicando un cambio (y avisará al terminar).
    if (companyChange) return companyChange
    return track(runObservedChange(previous, next))
  }

  return Object.assign(handleSessionError, {
    onCompanyObserved,
    isApplyingCompanyChange: () => companyChange !== null,
    resetCompanyNotices,
  })
}
