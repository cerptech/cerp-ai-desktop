import { tokenStore } from './tokenStore'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'
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

export async function fetchApiKey(httpClient: HttpClient): Promise<DesktopConfig> {
  const token = tokenStore.getAccessToken()
  logger.info(`Fetching API key from backend... (has token: ${!!token})`)

  try {
    const response = await httpClient.post<{
      apiKey: string
      companyId: string
      userId: string
      maxBudgetPerQuery: number
      model: string
      models?: { fast?: string; powerful?: string }
      modelPolicy?: AiModelPolicy
      maxBudgetUsd?: number
      maxBudgetUsdTurbo?: number
    }>('/desktop/api-key')

    logger.info(`API key response: hasKey=${!!response.apiKey}, companyId=${response.companyId}, userId=${response.userId}, model=${response.model}, tier=${response.modelPolicy?.tier ?? '-'}`)

    tokenStore.setApiKey(response.apiKey)

    if (response.companyId) tokenStore.setCompanyId(response.companyId)
    if (response.userId) tokenStore.setUserId(response.userId)

    cachedConfig = {
      apiKey: response.apiKey,
      companyId: response.companyId,
      userId: response.userId,
      maxBudgetPerQuery: response.maxBudgetPerQuery,
      model: response.model,
      models: response.models,
      modelPolicy: response.modelPolicy,
      maxBudgetUsd: response.maxBudgetUsd,
      maxBudgetUsdTurbo: response.maxBudgetUsdTurbo,
    }
    cachedConfigAt = Date.now()

    logger.info('API key fetched and stored successfully')
    return cachedConfig
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

/** true si ya hay config cacheada (para no pegarle al backend de más). */
export function hasCachedConfig(): boolean {
  return cachedConfig !== null
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

export function clearApiKey(): void {
  cachedConfig = null
  cachedConfigAt = 0
  tokenStore.clearApiKey()
}
