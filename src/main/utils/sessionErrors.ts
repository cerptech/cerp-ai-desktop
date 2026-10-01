/**
 * Errores de sesión y de empresa que manda el core (multi-empresa, contrato §7.7
 * del plan `multi-company-2026-09`). Módulo PURO: sin imports de Electron ni del
 * store, para que la clasificación se pueda probar sin levantar la app.
 *
 * - 409 `COMPANY_CHANGED` `{ details: { activeCompanyId } }`: el Desktop inyecta en
 *   cada tool el `companyId` que cacheó de `/desktop/api-key`; si la empresa por
 *   defecto de la persona cambió (re-homing al revocarla de su casa), el core NO
 *   ejecuta la operación y responde esto en vez de escribir en la casa nueva.
 * - 403 `NO_ACTIVE_COMPANY`: la cuenta no tiene ninguna empresa activa.
 * - 401 `SESSION_REVOKED`: las sesiones del usuario se cerraron por seguridad. Va
 *   por el camino de 401 de siempre (refresh + un reintento); solo si el reintento
 *   también lo recibe la sesión está muerta de verdad.
 *
 * Un core anterior a la épica nunca manda estos códigos: el Desktop nuevo es
 * compatible con el core viejo.
 */

export type SessionErrorKind = 'company_changed' | 'no_active_company' | 'session_revoked'

export interface SessionErrorInfo {
  kind: SessionErrorKind
  /** Solo en `company_changed`: la empresa que el core resolvió ahora (24 hex), si vino. */
  activeCompanyId: string | null
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i

/** Código del error: envelope `{ error: { code } }` (contrato) o plano `{ code }` (convención vieja de `/desktop`). */
export function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as { code?: unknown; error?: unknown }
  if (b.error && typeof b.error === 'object') {
    const code = (b.error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return typeof b.code === 'string' ? b.code : undefined
}

function readActiveCompanyId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const err = (body as { error?: unknown }).error
  const details = err && typeof err === 'object' ? (err as { details?: unknown }).details : undefined
  const id = details && typeof details === 'object' ? (details as { activeCompanyId?: unknown }).activeCompanyId : undefined
  return typeof id === 'string' && OBJECT_ID_RE.test(id) ? id : null
}

/**
 * Clasifica una respuesta de error del core. Devuelve `null` para todo lo que no
 * sea uno de los tres códigos con SU status (un 403 con otro código, un 409 de
 * negocio, un 401 de token vencido sin código, etc. siguen el manejo de siempre).
 */
export function classifySessionError(status: number, body: unknown): SessionErrorInfo | null {
  const code = readErrorCode(body)
  if (status === 409 && code === 'COMPANY_CHANGED') {
    return { kind: 'company_changed', activeCompanyId: readActiveCompanyId(body) }
  }
  if (status === 403 && code === 'NO_ACTIVE_COMPANY') return { kind: 'no_active_company', activeCompanyId: null }
  if (status === 401 && code === 'SESSION_REVOKED') return { kind: 'session_revoked', activeCompanyId: null }
  return null
}

/**
 * true si un 409 `COMPANY_CHANGED` ya está aplicado: el core informó la empresa
 * nueva y la config cacheada ya es esa. Pasa con las tools que siguen corriendo en
 * una sesión del agente que arrancó con la empresa vieja: no hay que volver a pedir
 * la config ni repetir el aviso.
 */
export function isCompanyChangeApplied(info: SessionErrorInfo, currentCompanyId: string | null): boolean {
  return info.kind === 'company_changed' && !!info.activeCompanyId && info.activeCompanyId === currentCompanyId
}

// ── Copy (español neutro, tuteo) ─────────────────────────────────────────────

/** Aviso al usuario tras un 409 `COMPANY_CHANGED` (plan DK-1.1). */
export function companyChangedMessage(companyName?: string | null): string {
  const name = companyName?.trim()
  return name
    ? `Tu empresa por defecto cambió a ${name}. Revisa la carpeta de trabajo antes de seguir.`
    : 'Tu empresa por defecto cambió. Revisa la carpeta de trabajo antes de seguir.'
}

/** Aviso al usuario tras un 403 `NO_ACTIVE_COMPANY` (plan DK-1.1); el Desktop cierra la sesión. */
export const NO_ACTIVE_COMPANY_MESSAGE = 'Tu cuenta ya no tiene acceso a ninguna empresa.'

/**
 * Texto que recibe el MODELO como error de la tool. La operación no se ejecutó y
 * no hay que reintentarla: la config se refresca sola y el turno se detiene; el
 * próximo mensaje del usuario arranca la sesión con la empresa nueva.
 */
export const COMPANY_CHANGED_TOOL_ERROR =
  'COMPANY_CHANGED: la empresa por defecto del usuario cambió y esta operación NO se ejecutó (no se escribió nada). ' +
  'No la reintentes ni sigas con otras operaciones en este turno: avísale al usuario que su empresa por defecto cambió ' +
  'y que revise la carpeta de trabajo antes de volver a enviar el mensaje.'

export const NO_ACTIVE_COMPANY_TOOL_ERROR =
  'NO_ACTIVE_COMPANY: la cuenta del usuario ya no tiene acceso a ninguna empresa en CERP y esta operación NO se ejecutó. No la reintentes.'

export const SESSION_REVOKED_TOOL_ERROR =
  'SESSION_REVOKED: la sesión del usuario se cerró por seguridad y esta operación NO se ejecutó. No la reintentes: el usuario tiene que volver a iniciar sesión.'

/**
 * Nombre de la empresa activa a partir de `GET /api/users/me` (contrato §7.1:
 * `companyId` es `null | { _id, name, … }`). Acepta la respuesta envuelta en `data`.
 */
export function companyNameFromSessionUser(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const wrapped = (body as { data?: unknown }).data
  const user = wrapped && typeof wrapped === 'object' ? wrapped : body
  const company = (user as { companyId?: unknown }).companyId
  if (!company || typeof company !== 'object') return null
  const name = (company as { name?: unknown }).name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}
