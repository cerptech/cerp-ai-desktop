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
