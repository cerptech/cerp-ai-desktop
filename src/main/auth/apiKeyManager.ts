import { tokenStore } from './tokenStore'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import type { DesktopConfig } from '../ipc/types'

let cachedConfig: DesktopConfig | null = null

export async function fetchApiKey(httpClient: HttpClient): Promise<DesktopConfig> {
  // Check cached key first
  const storedKey = tokenStore.getApiKey()
  if (storedKey && cachedConfig) {
    return cachedConfig
  }

  const token = tokenStore.getAccessToken()
  logger.info(`Fetching API key from backend... (has token: ${!!token})`)

  try {
    const response = await httpClient.post<{
      apiKey: string
      maxBudgetPerQuery: number
      model: string
    }>('/desktop/api-key')

    logger.info(`API key response: hasKey=${!!response.apiKey}, model=${response.model}`)

    tokenStore.setApiKey(response.apiKey)

    cachedConfig = {
      apiKey: response.apiKey,
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

export function clearApiKey(): void {
  cachedConfig = null
  tokenStore.clearApiKey()
}
