import { shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { tokenStore } from './tokenStore'
import { logger } from '../utils/logger'

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || ''
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || ''
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || ''
const REDIRECT_URI = 'cerp-ai://callback'

let codeVerifier: string | null = null
let loginResolve: ((token: string) => void) | null = null
let loginReject: ((err: Error) => void) | null = null

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest()
  return base64URLEncode(hash)
}

export async function login(): Promise<string> {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    // Dev mode: use stored token or throw
    const token = tokenStore.getAccessToken()
    if (token) return token
    throw new Error('Auth0 not configured. Set AUTH0_DOMAIN and AUTH0_CLIENT_ID in .env')
  }

  return new Promise((resolve, reject) => {
    loginResolve = resolve
    loginReject = reject

    codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: AUTH0_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email',
      audience: AUTH0_AUDIENCE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    const authUrl = `https://${AUTH0_DOMAIN}/authorize?${params}`
    logger.info('Opening Auth0 login in system browser')
    shell.openExternal(authUrl)

    // Timeout after 5 minutes
    setTimeout(() => {
      if (loginReject) {
        loginReject(new Error('Login timed out'))
        loginResolve = null
        loginReject = null
      }
    }, 5 * 60 * 1000)
  })
}

export async function handleCallback(url: string): Promise<void> {
  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code')
    const error = parsed.searchParams.get('error')

    if (error) {
      const desc = parsed.searchParams.get('error_description') || error
      loginReject?.(new Error(`Auth0 error: ${desc}`))
      return
    }

    if (!code || !codeVerifier) {
      loginReject?.(new Error('Missing authorization code or verifier'))
      return
    }

    // Exchange code for token
    const tokenResponse = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: AUTH0_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    })

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text()
      loginReject?.(new Error(`Token exchange failed: ${body}`))
      return
    }

    const { access_token } = (await tokenResponse.json()) as { access_token: string }

    // Fetch user info
    const userInfoRes = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    if (userInfoRes.ok) {
      const userInfo = (await userInfoRes.json()) as Record<string, string>
      tokenStore.setUser({
        name: userInfo.name || userInfo.nickname || '',
        email: userInfo.email || '',
        picture: userInfo.picture,
        companyId: '', // Will be populated from backend
        companyName: '',
      })
    }

    tokenStore.setAccessToken(access_token)
    logger.info('Auth0 login successful')
    loginResolve?.(access_token)
  } catch (err) {
    logger.error('Auth0 callback error:', err)
    loginReject?.(err instanceof Error ? err : new Error(String(err)))
  } finally {
    codeVerifier = null
    loginResolve = null
    loginReject = null
  }
}

export function logout(): void {
  tokenStore.clearAll()
  logger.info('User logged out')
}

export function isAuthenticated(): boolean {
  return tokenStore.getAccessToken() !== null
}
