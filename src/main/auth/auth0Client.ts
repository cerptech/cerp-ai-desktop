import { shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { createServer, Server } from 'http'
import { tokenStore } from './tokenStore'
import { clearApiKey } from './apiKeyManager'
import { logger } from '../utils/logger'

// Margen de seguridad: un token que expira dentro de este umbral se trata
// como expirado, para no arrancar una request con un token que muere a mitad
// de camino en el servidor.
const EXPIRY_MARGIN_MS = 60 * 1000

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

        const { access_token, refresh_token, expires_in } = (await tokenResponse.json()) as {
          access_token: string
          refresh_token?: string
          expires_in?: number
        }

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

        tokenStore.setSession({
          accessToken: access_token,
          refreshToken: refresh_token ?? null,
          expiresAt: Date.now() + (expires_in ?? 3600) * 1000,
        })

        if (!refresh_token) {
          logger.warn('Auth0 no devolvió refresh_token — revisar que "Allow Offline Access" esté habilitado en la Application/API de Auth0')
        }

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
        // offline_access → Auth0 emite refresh_token (requiere "Allow Offline Access"
        // habilitado en la Application y en la API de Auth0; ver README de config).
        scope: 'openid profile email offline_access',
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
  clearApiKey()
  logger.info('User logged out')
}

/**
 * Solo mira el estado guardado — no refresca. Usar `ensureFreshToken()` en
 * cualquier flujo que vaya a hacer una llamada real (arranque de la app,
 * AUTH_GET_STATUS), para que un token vencido se refresque en vez de leerse
 * como "logueado" con un token muerto.
 */
export function isAuthenticated(): boolean {
  const token = tokenStore.getAccessToken()
  if (!token) return false
  const expiresAt = tokenStore.getExpiresAt()
  // Migración: credenciales guardadas antes de este campo existir → tratar
  // como expiradas, fuerza un único login limpio.
  if (expiresAt === null) return false
  return Date.now() < expiresAt - EXPIRY_MARGIN_MS
}

/**
 * Intercambia el refresh token guardado por un accessToken nuevo. Auth0 puede
 * rotar el refresh token (Refresh Token Rotation) — si viene uno nuevo en la
 * respuesta lo persistimos; si no, mantenemos el actual.
 */
export async function refreshAccessToken(): Promise<string> {
  const { domain, clientId } = getAuth0Config()
  const refreshToken = tokenStore.getRefreshToken()

  if (!domain || !clientId || !refreshToken) {
    throw new Error('No hay refresh token disponible para renovar la sesión')
  }

  const res = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`No se pudo renovar el token: ${res.status} ${body}`)
  }

  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }

  tokenStore.setSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  })

  logger.info('Access token renovado correctamente')
  return data.access_token
}

/**
 * Devuelve un accessToken válido, refrescándolo primero si está por vencer.
 * `null` significa "no hay sesión utilizable" — ni token vigente ni refresh
 * posible (sin refresh token, o el refresh falló porque fue revocado/venció).
 * Usar esto en vez de `isAuthenticated()` en cualquier punto que vaya a hacer
 * una llamada de red real.
 */
export async function ensureFreshToken(): Promise<string | null> {
  const token = tokenStore.getAccessToken()
  if (!token) return null

  const expiresAt = tokenStore.getExpiresAt()
  if (expiresAt === null) {
    logger.warn('Token sin fecha de expiración guardada (credenciales antiguas) — se requiere un nuevo login')
    return null
  }

  if (Date.now() < expiresAt - EXPIRY_MARGIN_MS) return token

  try {
    return await refreshAccessToken()
  } catch (err) {
    logger.warn('No se pudo refrescar el token de acceso:', err)
    return null
  }
}
