import { shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { createServer, Server } from 'http'
import { tokenStore } from './tokenStore'
import { logger } from '../utils/logger'

// Read env vars lazily (dotenv loads after imports are evaluated)
function getAuth0Config() {
  return {
    domain: process.env.AUTH0_DOMAIN || '',
    clientId: process.env.AUTH0_CLIENT_ID || '',
    audience: process.env.AUTH0_AUDIENCE || '',
  }
}

const CALLBACK_PORT = 18973 // Fixed port for local callback server
const LOCAL_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

let codeVerifier: string | null = null
let callbackServer: Server | null = null

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

/**
 * Login flow:
 * 1. Start a local HTTP server on port 51973
 * 2. Open Auth0 in system browser with redirect_uri = http://localhost:51973/callback
 * 3. Auth0 redirects browser to localhost after login
 * 4. Local server receives the code, exchanges it for token, closes
 */
export async function login(): Promise<string> {
  const { domain, clientId, audience } = getAuth0Config()
  logger.info(`Auth0 config: domain=${domain}, clientId=${clientId ? '***' : 'MISSING'}, audience=${audience}`)

  if (!domain || !clientId) {
    const token = tokenStore.getAccessToken()
    if (token) return token
    throw new Error('Auth0 not configured. Set AUTH0_DOMAIN and AUTH0_CLIENT_ID in .env')
  }

  // Clean up any existing server
  if (callbackServer) {
    callbackServer.close()
    callbackServer = null
  }

  return new Promise((resolve, reject) => {
    codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    // Start local HTTP server to receive the callback
    callbackServer = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`)

      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        const desc = url.searchParams.get('error_description') || error
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Error de autenticacion</h2><p>Puedes cerrar esta ventana.</p></body></html>')
        cleanup()
        reject(new Error(`Auth0 error: ${desc}`))
        return
      }

      if (!code || !codeVerifier) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Error</h2><p>Codigo de autorizacion no recibido.</p></body></html>')
        cleanup()
        reject(new Error('Missing authorization code'))
        return
      }

      try {
        // Exchange code for token
        const tokenResponse = await fetch(`https://${domain}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: LOCAL_REDIRECT_URI,
            code_verifier: codeVerifier,
          }),
        })

        if (!tokenResponse.ok) {
          const body = await tokenResponse.text()
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h2>Error</h2><p>No se pudo completar el login. Puedes cerrar esta ventana.</p></body></html>')
          cleanup()
          reject(new Error(`Token exchange failed: ${body}`))
          return
        }

        const { access_token } = (await tokenResponse.json()) as { access_token: string }

        // Fetch user info
        const userInfoRes = await fetch(`https://${domain}/userinfo`, {
          headers: { Authorization: `Bearer ${access_token}` },
        })

        if (userInfoRes.ok) {
          const userInfo = (await userInfoRes.json()) as Record<string, string>
          tokenStore.setUser({
            name: userInfo.name || userInfo.nickname || '',
            email: userInfo.email || '',
            picture: userInfo.picture,
            companyId: '',
            companyName: '',
          })
        }

        tokenStore.setAccessToken(access_token)

        // Success page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">
          <div style="text-align:center">
            <div style="width:60px;height:60px;border-radius:16px;background:#FE700B;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
              <span style="color:white;font-size:28px;font-weight:bold">C</span>
            </div>
            <h2 style="color:#1e293b;margin:0 0 8px">Login exitoso</h2>
            <p style="color:#64748b">Puedes cerrar esta ventana y volver a CERP AI.</p>
          </div>
        </body></html>`)

        logger.info('Auth0 login successful')
        cleanup()
        resolve(access_token)
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Error</h2><p>Error inesperado. Puedes cerrar esta ventana.</p></body></html>')
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    callbackServer.listen(CALLBACK_PORT, '127.0.0.1', () => {
      logger.info(`Callback server listening on port ${CALLBACK_PORT}`)

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: LOCAL_REDIRECT_URI,
        scope: 'openid profile email',
        audience: audience,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })

      const authUrl = `https://${domain}/authorize?${params}`
      logger.info(`Opening Auth0 login in browser`)
      shell.openExternal(authUrl)
    })

    callbackServer.on('error', (err) => {
      logger.error('Callback server error:', err)
      reject(new Error(`Could not start callback server: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      cleanup()
      reject(new Error('Login timed out'))
    }, 5 * 60 * 1000)
  })

  function cleanup() {
    codeVerifier = null
    if (callbackServer) {
      callbackServer.close()
      callbackServer = null
    }
  }
}

// Keep for production use with custom protocol
export async function handleCallback(_url: string): Promise<void> {
  // Not used in dev mode (local HTTP server handles callback)
}

export function logout(): void {
  tokenStore.clearAll()
  logger.info('User logged out')
}

export function isAuthenticated(): boolean {
  return tokenStore.getAccessToken() !== null
}
