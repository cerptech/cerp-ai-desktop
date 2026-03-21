import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Simple JSON file store (replaces electron-store to avoid ESM/CJS issues)
const STORE_PATH = join(app.getPath('userData'), 'cerp-credentials.json')

function readStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function writeStore(data: Record<string, unknown>): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2))
  } catch {
    // ignore write errors
  }
}

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
    const data = readStore()
    data.accessToken = encrypt(token)
    writeStore(data)
  },

  getAccessToken(): string | null {
    const data = readStore()
    const val = data.accessToken as string | undefined
    if (!val) return null
    return decrypt(val)
  },

  setApiKey(key: string, expiresInMs = 24 * 60 * 60 * 1000): void {
    const data = readStore()
    data.apiKey = encrypt(key)
    data.apiKeyExpiresAt = Date.now() + expiresInMs
    writeStore(data)
  },

  getApiKey(): string | null {
    const data = readStore()
    const expiresAt = data.apiKeyExpiresAt as number | undefined
    if (expiresAt && Date.now() > expiresAt) {
      this.clearApiKey()
      return null
    }
    const val = data.apiKey as string | undefined
    if (!val) return null
    return decrypt(val)
  },

  setUser(user: { name: string; email: string; picture?: string; companyId: string; companyName: string }): void {
    const data = readStore()
    data.user = user
    writeStore(data)
  },

  getUser(): { name: string; email: string; picture?: string; companyId: string; companyName: string } | null {
    const data = readStore()
    return (data.user as ReturnType<typeof this.getUser>) || null
  },

  clearApiKey(): void {
    const data = readStore()
    delete data.apiKey
    delete data.apiKeyExpiresAt
    writeStore(data)
  },

  clearAll(): void {
    writeStore({})
  },
}
