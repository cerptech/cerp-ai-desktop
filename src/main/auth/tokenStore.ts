import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'cerp-credentials' })

function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(encoded: string): string {
  if (!safeStorage.isEncryptionAvailable()) return encoded
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
}

export const tokenStore = {
  setAccessToken(token: string): void {
    store.set('accessToken', encrypt(token))
  },

  getAccessToken(): string | null {
    const val = store.get('accessToken') as string | undefined
    if (!val) return null
    return decrypt(val)
  },

  setApiKey(key: string, expiresInMs = 24 * 60 * 60 * 1000): void {
    store.set('apiKey', encrypt(key))
    store.set('apiKeyExpiresAt', Date.now() + expiresInMs)
  },

  getApiKey(): string | null {
    const expiresAt = store.get('apiKeyExpiresAt') as number | undefined
    if (expiresAt && Date.now() > expiresAt) {
      this.clearApiKey()
      return null
    }
    const val = store.get('apiKey') as string | undefined
    if (!val) return null
    return decrypt(val)
  },

  setUser(user: { name: string; email: string; picture?: string; companyId: string; companyName: string }): void {
    store.set('user', user)
  },

  getUser(): { name: string; email: string; picture?: string; companyId: string; companyName: string } | null {
    return (store.get('user') as ReturnType<typeof this.getUser>) || null
  },

  clearApiKey(): void {
    store.delete('apiKey')
    store.delete('apiKeyExpiresAt')
  },

  clearAll(): void {
    store.clear()
  },
}
