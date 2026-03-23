import { tokenStore } from './tokenStore'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { DesktopConfig } from '../ipc/types'

let cachedConfig: DesktopConfig | null = null

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
    }

    logger.info('API key fetched and stored successfully')
    return cachedConfig
  } catch (err) {
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

export function clearApiKey(): void {
  cachedConfig = null
  tokenStore.clearApiKey()
}
