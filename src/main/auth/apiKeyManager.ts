import { tokenStore } from './tokenStore'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { DesktopConfig } from '../ipc/types'

let cachedConfig: DesktopConfig | null = null

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
      maxBudgetUsd?: number
      maxBudgetUsdTurbo?: number
    }>('/desktop/api-key')

    logger.info(`API key response: hasKey=${!!response.apiKey}, companyId=${response.companyId}, userId=${response.userId}, model=${response.model}`)

    tokenStore.setApiKey(response.apiKey)

    if (response.companyId) tokenStore.setCompanyId(response.companyId)
    if (response.userId) tokenStore.setUserId(response.userId)

    cachedConfig = {
      apiKey: response.apiKey,
      companyId: response.companyId,
      userId: response.userId,
      maxBudgetPerQuery: response.maxBudgetPerQuery,
      model: response.model,
      maxBudgetUsd: response.maxBudgetUsd,
      maxBudgetUsdTurbo: response.maxBudgetUsdTurbo,
    }

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

/** Techo de coste por sesión (modo normal) informado por el backend, si ya se cacheó. */
export function getMaxBudgetUsd(): number | undefined {
  return cachedConfig?.maxBudgetUsd
}

/** Techo de coste por sesión en Turbo Mode informado por el backend, si ya se cacheó. */
export function getMaxBudgetUsdTurbo(): number | undefined {
  return cachedConfig?.maxBudgetUsdTurbo
}

export function clearApiKey(): void {
  cachedConfig = null
  tokenStore.clearApiKey()
}
