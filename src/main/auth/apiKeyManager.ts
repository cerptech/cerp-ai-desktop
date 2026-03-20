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

  logger.info('Fetching API key from backend...')

  const response = await httpClient.post<{
    apiKey: string
    maxBudgetPerQuery: number
    model: string
  }>('/desktop/api-key')

  // Store encrypted
  tokenStore.setApiKey(response.apiKey)

  cachedConfig = {
    apiKey: response.apiKey,
    maxBudgetPerQuery: response.maxBudgetPerQuery,
    model: response.model,
  }

  logger.info('API key fetched and stored successfully')
  return cachedConfig
}

export function getApiKey(): string | null {
  return cachedConfig?.apiKey ?? tokenStore.getApiKey()
}

export function clearApiKey(): void {
  cachedConfig = null
  tokenStore.clearApiKey()
}
