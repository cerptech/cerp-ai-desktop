import {
  companyChangedMessage,
  isCompanyChangeApplied,
  NO_ACTIVE_COMPANY_MESSAGE,
  type SessionErrorInfo,
} from '../utils/sessionErrors'

/**
 * Reacción del Desktop a los errores de sesión/empresa del core (multi-empresa,
 * plan DK-1.1; contrato §7.7). El `HttpClient` los detecta y avisa acá sin esperar;
 * el request que los recibió ya lanzó su error tipado y NO se reintenta.
 *
 * Sin imports de Electron ni del store: todo efecto entra por `deps`, así la lógica
 * (deduplicado, orden de pasos, qué se avisa) se prueba sin levantar la app.
 */

export interface CompanyChangedNotice {
  /** Empresa nueva (de `/desktop/api-key`, o de `details.activeCompanyId` si el refetch falló). */
  companyId: string | null
  companyName: string | null
  message: string
}

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
}

/** Ventana en la que varios 403/401 concurrentes cuentan como UN solo cierre de sesión. */
const SIGN_OUT_DEDUPE_MS = 10_000

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
}

export function createSessionGuard(deps: SessionGuardDeps): SessionGuard {
  const now = deps.now ?? Date.now
  let companyChange: Promise<void> | null = null
  /** Última empresa avisada: un 409 tardío de una sesión vieja no repite el aviso. */
  let lastNotifiedCompanyId: string | null = null
  let lastNoCompanySignOut = Number.NEGATIVE_INFINITY
  let lastRevokedSignOut = Number.NEGATIVE_INFINITY

  async function notifyChange(companyId: string | null): Promise<void> {
    if (companyId !== null && companyId === lastNotifiedCompanyId) {
      deps.log.info(`[session] Cambio a ${companyId} ya avisado — no se repite el aviso`)
      return
    }
    if (companyId !== null) lastNotifiedCompanyId = companyId
    let companyName: string | null = null
    try {
      companyName = await deps.fetchCompanyName()
    } catch {
      /* el aviso sale sin nombre */
    }
    deps.notifyCompanyChanged({ companyId, companyName, message: companyChangedMessage(companyName) })
  }

  async function runCompanyChange(info: SessionErrorInfo): Promise<void> {
    const previous = deps.getCompanyId()
    deps.log.warn(`[session] 409 COMPANY_CHANGED: la empresa por defecto cambió (antes ${previous ?? '-'}, ahora ${info.activeCompanyId ?? '?'})`)
    deps.invalidateCompanyConfig()

    let companyId = info.activeCompanyId
    try {
      companyId = (await deps.refetchCompanyId()) ?? companyId
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
      return
    }

    if (now() - lastRevokedSignOut < SIGN_OUT_DEDUPE_MS) return
    lastRevokedSignOut = now()
    deps.log.warn('[session] 401 SESSION_REVOKED después del refresh — la sesión se cerró por seguridad')
    deps.signOutSessionRevoked()
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
  })
}
