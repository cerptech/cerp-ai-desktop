import { tokenStore } from './tokenStore'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { isCompanySwitch } from '../utils/sessionErrors'
import type { AiModelPolicy, DesktopConfig } from '../ipc/types'

let cachedConfig: DesktopConfig | null = null
let cachedConfigAt = 0

/**
 * La política de modelo de la empresa cambia sola (cruza el umbral de consumo
 * a mitad de período, o el período resetea): la config se considera vieja
 * pasados 5 min y el envío de un prompt la refresca antes de resolver el modelo.
 */
const CONFIG_TTL_MS = 5 * 60 * 1000

/**
 * La empresa no tiene créditos disponibles (Modelo CERP). El backend responde
 * 402 `{ error: { code: 'NO_CREDITS' } }` en `/desktop/api-key`. Distinguible de
 * un fallo de red/auth genérico por `.code === 'NO_CREDITS'` — el caller/renderer
 * decide qué hacer (la UI del paywall se conecta en otra fase).
 */
export class NoCreditsError extends Error {
  readonly code = 'NO_CREDITS' as const

  constructor(message = 'La empresa no tiene créditos disponibles') {
    super(message)
    this.name = 'NoCreditsError'
  }
}

/**
 * El core no entrega la API key a este usuario: 403 `FORBIDDEN` (su rol o su
 * grupo no tiene habilitado el módulo «CERP IA Desktop») o 403
 * `SUBSCRIPTION_BLOCKED` (suscripción de la empresa inactiva). Hasta el
 * 06-10-2026 los dos caían en el genérico «No se pudo conectar con el
 * servidor» y Camacho lo reportó como una caída. Es una negativa definitiva,
 * no un fallo de red: no se reintenta con la key cacheada.
 */
export class DesktopAccessDeniedError extends Error {
  readonly code = 'ACCESS_DENIED' as const
  readonly reason: 'FORBIDDEN' | 'SUBSCRIPTION_BLOCKED'

  constructor(reason: 'FORBIDDEN' | 'SUBSCRIPTION_BLOCKED') {
    super(
      reason === 'SUBSCRIPTION_BLOCKED'
        ? 'La suscripción de tu empresa está inactiva. Reactívala desde app.cerp.es para seguir usando CERP IA Desktop.'
        : 'Tu usuario no tiene habilitado CERP IA Desktop. Pide al administrador de tu empresa que lo active en Configuración > Roles y permisos (módulo «CERP IA Desktop»).',
    )
    this.name = 'DesktopAccessDeniedError'
    this.reason = reason
  }
}

/**
 * Texto del aviso de versión mínima. Lo arma el cliente a partir del código, no lo
 * copia del servidor: el body de un error no es un texto de confianza para la UI.
 */
export const DESKTOP_UPDATE_REQUIRED_MESSAGE = 'Actualiza CERP IA Desktop a la última versión para seguir usándolo.'

/**
 * El core exige una versión más nueva del Desktop para entregar la config (F0.2 (b)
 * del plan CERP IA Q4-2026): 426 `DESKTOP_UPDATE_REQUIRED` en `/desktop/api-key`.
 * Es una negativa definitiva hasta actualizar, no un fallo de red: no se sigue con
 * la key cacheada.
 */
export class DesktopUpdateRequiredError extends Error {
  readonly code = 'DESKTOP_UPDATE_REQUIRED' as const
  readonly minVersion: string | null

  constructor(minVersion: string | null) {
    super(DESKTOP_UPDATE_REQUIRED_MESSAGE)
    this.name = 'DesktopUpdateRequiredError'
    this.minVersion = minVersion
  }
}

/**
 * Texto del aviso de empresa sin método de pago. Local, por código, como el de versión
 * mínima: el body del 402 no es un texto de confianza para la UI.
 */
export const PAYMENT_METHOD_REQUIRED_MESSAGE = 'Para usar CERP IA Desktop, tu empresa tiene que añadir un método de pago en app.cerp.es.'

/**
 * La empresa se dio de alta sin método de pago: el core responde 402
 * `PAYMENT_METHOD_REQUIRED` en `/desktop/api-key`. Hasta la 1.0.42 caía en el
 * «se sigue con la key cacheada». Ahora para igual que `NO_CREDITS`: no se sigue con
 * la cacheada y, como ante `NO_CREDITS`, la key no se borra del disco (a diferencia
 * de los 403). Al añadir el método de pago, el siguiente refresco de la config
 * vuelve a funcionar sin volver a iniciar sesión.
 */
export class PaymentMethodRequiredError extends Error {
  readonly code = 'PAYMENT_METHOD_REQUIRED' as const

  constructor() {
    super(PAYMENT_METHOD_REQUIRED_MESSAGE)
    this.name = 'PaymentMethodRequiredError'
  }
}

/**
 * Allowlist cerrada, como en cerp-ai-service: una política malformada (p.ej.
 * sin `maxTier` por un bug de serialización) se descarta ENTERA. Si se
 * aceptara a medias, `resolveModel` bloquearía "Potente" para todas las
 * empresas o, peor, lo dejaría pasar sin techo.
 */
function isTier(v: unknown): v is AiModelPolicy['tier'] {
  return v === 'economy' || v === 'standard' || v === 'powerful'
}
function parseModelPolicy(raw: unknown): AiModelPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { tier, maxTier, degraded } = raw as Record<string, unknown>
  if (!isTier(tier) || !isTier(maxTier)) return undefined
  return { tier, maxTier, degraded: degraded === true }
}
function parseModels(raw: unknown): { fast?: string; powerful?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { fast, powerful } = raw as Record<string, unknown>
  const out: { fast?: string; powerful?: string } = {}
  if (typeof fast === 'string' && fast) out.fast = fast
  if (typeof powerful === 'string' && powerful) out.powerful = powerful
  return out
}

type CompanySwitchObserver = (previousCompanyId: string, nextCompanyId: string) => void
let companySwitchObserver: CompanySwitchObserver | null = null
/**
 * Cuántos cambios de empresa vio `fetchApiKey` desde que arrancó la app. El envío de
 * un prompt (AGENT_SEND_PROMPT) lo lee antes y después de refrescar la config: si
 * cambió, el refresco trajo otra empresa y el prompt NO se corre (corrección 2 de
 * la review de DK1: el prompt se escribió para la empresa vieja).
 */
let companySwitchSeq = 0

/** Contador de cambios de empresa observados por `fetchApiKey` (ver `companySwitchSeq`). */
export function getCompanySwitchSeq(): number {
  return companySwitchSeq
}

/**
 * Multi-empresa (plan DK-1.1): quién reacciona cuando `fetchApiKey` trae otra
 * empresa que la cacheada (el guard de sesión, ver handlers.ts). Se llama de forma
 * SÍNCRONA antes de que `fetchApiKey` devuelva, para que la parte síncrona del
 * manejo (detener turnos, tirar el contexto de empresa del prompt) ya esté hecha
 * cuando el caller arranque o reinicie una sesión con la empresa nueva.
 */
export function setCompanySwitchObserver(observer: CompanySwitchObserver | null): void {
  companySwitchObserver = observer
}

function notifyCompanySwitch(previousCompanyId: string, nextCompanyId: string): void {
  logger.warn(`La config trajo otra empresa por defecto (antes ${previousCompanyId}, ahora ${nextCompanyId})`)
  if (!companySwitchObserver) return
  try {
    companySwitchObserver(previousCompanyId, nextCompanyId)
  } catch (err) {
    logger.warn(`El manejo del cambio de empresa falló: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * `skipAuthRetry`: sin el refresh automático ante un 401. Lo usa `onTokenExpired`
 * (handlers.ts), que llama a esto DENTRO del refresh en vuelo: con el reintento
 * normal, un 401 acá esperaría a ese mismo refresh (deadlock, ver httpClient.request).
 */
export async function fetchApiKey(httpClient: HttpClient, opts?: { skipAuthRetry?: boolean }): Promise<DesktopConfig> {
  const token = tokenStore.getAccessToken()
  logger.info(`Fetching API key from backend... (has token: ${!!token})`)

  try {
    const response = await httpClient.request<{
      apiKey: string
      companyId: string
      userId: string
      maxBudgetPerQuery: number
      model: string
      models?: { fast?: string; powerful?: string }
      modelPolicy?: AiModelPolicy
      maxBudgetUsd?: number
      maxBudgetUsdTurbo?: number
      spanishVariant?: unknown
    }>('POST', '/desktop/api-key', undefined, opts?.skipAuthRetry === true)

    logger.info(`API key response: hasKey=${!!response.apiKey}, companyId=${response.companyId}, userId=${response.userId}, model=${response.model}, tier=${response.modelPolicy?.tier ?? '-'}`)

    // Multi-empresa (DK-1.1): la empresa ANTES de pisarla, para detectar un cambio
    // que el refresco normal de la config trae sin pasar por un 409.
    const prevCompanyId = getCompanyId()
    const prevUserId = getUserId()

    tokenStore.setApiKey(response.apiKey)

    if (response.companyId) tokenStore.setCompanyId(response.companyId)
    if (response.userId) tokenStore.setUserId(response.userId)

    cachedConfig = {
      apiKey: response.apiKey,
      companyId: response.companyId,
      userId: response.userId,
      maxBudgetPerQuery: response.maxBudgetPerQuery,
      model: response.model,
      models: parseModels(response.models),
      modelPolicy: parseModelPolicy(response.modelPolicy),
      maxBudgetUsd: response.maxBudgetUsd,
      maxBudgetUsdTurbo: response.maxBudgetUsdTurbo,
      // Allowlist cerrada: un valor raro (o un backend viejo) queda sin variante.
      spanishVariant:
        response.spanishVariant === 'es' || response.spanishVariant === 'es-419' ? response.spanishVariant : undefined,
    }
    cachedConfigAt = Date.now()

    const config = cachedConfig
    if (isCompanySwitch(prevCompanyId, response.companyId || null, prevUserId, response.userId || null)) {
      companySwitchSeq++
      notifyCompanySwitch(prevCompanyId as string, response.companyId)
    }

    logger.info('API key fetched and stored successfully')
    return config
  } catch (err) {
    // Versión mínima (F0.2 (b)) y empresa sin método de pago: se deciden por el código,
    // no por el status, para que un cambio de status del lado del core no reabra el
    // «se usa la cacheada».
    if (err instanceof HttpError) {
      const body = err.body as { code?: string; minVersion?: unknown; error?: { code?: string } } | undefined
      const code = body?.code ?? body?.error?.code
      if (code === 'DESKTOP_UPDATE_REQUIRED') {
        const minVersion = typeof body?.minVersion === 'string' ? body.minVersion : null
        logger.warn(`fetchApiKey: el core exige actualizar el Desktop (${err.status} DESKTOP_UPDATE_REQUIRED, mínima ${minVersion ?? '-'})`)
        // Una versión que el core ya no acepta no conserva la key en disco.
        clearApiKey()
        throw new DesktopUpdateRequiredError(minVersion)
      }
      if (code === 'PAYMENT_METHOD_REQUIRED') {
        logger.warn(`fetchApiKey: la empresa no tiene método de pago (${err.status} PAYMENT_METHOD_REQUIRED)`)
        // Como NO_CREDITS: para, sin borrar la key del disco. La config queda vieja para
        // que el próximo envío vuelva a preguntar en vez de seguir con la cacheada.
        cachedConfigAt = 0
        throw new PaymentMethodRequiredError()
      }
    }
    if (err instanceof HttpError && err.status === 402) {
      // El endpoint /desktop/api-key responde el shape PLANO { message, code }
      // (convención de ese archivo); se acepta también el anidado { error: { code } }
      // del resto de la API por si el handler converge al estándar.
      const body = err.body as { code?: string; error?: { code?: string } } | undefined
      const code = body?.code ?? body?.error?.code
      if (code === 'NO_CREDITS') {
        logger.warn('fetchApiKey: la empresa no tiene créditos disponibles (402 NO_CREDITS)')
        throw new NoCreditsError()
      }
    }
    if (err instanceof HttpError && err.status === 403) {
      const body = err.body as { code?: string; error?: { code?: string } } | undefined
      const code = body?.code ?? body?.error?.code
      if (code === 'FORBIDDEN' || code === 'SUBSCRIPTION_BLOCKED') {
        logger.warn(`fetchApiKey: acceso denegado por el core (403 ${code})`)
        // Un usuario al que le quitaron el acceso no conserva la key en disco.
        clearApiKey()
        throw new DesktopAccessDeniedError(code)
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`fetchApiKey FAILED: ${msg}`)
    throw err
  }
}

export function getApiKey(): string | null {
  return cachedConfig?.apiKey ?? tokenStore.getApiKey()
}

export function getCompanyId(): string | null {
  return cachedConfig?.companyId ?? tokenStore.getCompanyId()
}

export function getUserId(): string | null {
  return cachedConfig?.userId ?? tokenStore.getUserId()
}

/**
 * Modelo por defecto que devuelve el backend en /desktop/api-key (config por plan/empresa).
 * Usado por el selector de modelo cuando el usuario elige "Auto" (Ola 1). Puede faltar si
 * todavía no se cacheó la config — el caller debe tener un fallback hardcodeado.
 */
export function getConfiguredModel(): string | undefined {
  return cachedConfig?.model
}

/**
 * Modelos de "Rápido" / "Potente" informados por el backend (ya recortados por la
 * política de la empresa). Ausentes con un backend anterior o sin config cacheada.
 */
export function getConfiguredModels(): { fast?: string; powerful?: string } | undefined {
  return cachedConfig?.models
}

/** Política de modelo de la empresa (ADR 016), si el backend la informó. */
export function getModelPolicy(): AiModelPolicy | null {
  return cachedConfig?.modelPolicy ?? null
}

/** En qué español habla CERP IA (RQM-188), si el backend lo informó. */
export function getSpanishVariant(): DesktopConfig['spanishVariant'] {
  return cachedConfig?.spanishVariant
}

/** true si no hay config o pasó el TTL: hay que volver a pedirla al backend. */
export function isConfigStale(): boolean {
  return cachedConfig === null || Date.now() - cachedConfigAt > CONFIG_TTL_MS
}

/** Techo de coste por sesión (modo normal) informado por el backend, si ya se cacheó. */
export function getMaxBudgetUsd(): number | undefined {
  return cachedConfig?.maxBudgetUsd
}

/**
 * Techo de coste por sesión cuando el modo elegido es "Potente" (Opus + xhigh),
 * informado por el backend, si ya se cacheó. El nombre del campo (`maxBudgetUsdTurbo`)
 * se heredó del antiguo Modo Turbo — el contrato con el backend no cambió.
 */
export function getMaxBudgetUsdTurbo(): number | undefined {
  return cachedConfig?.maxBudgetUsdTurbo
}

/**
 * 409 `COMPANY_CHANGED` (multi-empresa, plan DK-1.1): la empresa por defecto de la
 * persona cambió. Se tira la config cacheada y el `companyId` persistido para que
 * nada siga inyectando la empresa vieja; el caller vuelve a pedir `/desktop/api-key`.
 * La API key queda: no depende de la empresa y el refetch la reescribe igual.
 */
export function invalidateCompanyConfig(): void {
  cachedConfig = null
  cachedConfigAt = 0
  tokenStore.clearCompanyId()
}

export function clearApiKey(): void {
  cachedConfig = null
  cachedConfigAt = 0
  tokenStore.clearApiKey()
}
