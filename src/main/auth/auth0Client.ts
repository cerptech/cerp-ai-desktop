import { BrowserWindow, shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { readFileSync } from 'fs'
import { createServer, Server } from 'http'
import cerpLogoPath from '../../../resources/cerp-logo.png?asset'
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

/** La cuenta que acaba de iniciar sesión, para mostrarla en la página de éxito. */
interface CallbackAccount {
  name: string
  email: string
  verified: boolean
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Iniciales del avatar: nombre + primer apellido (con 4 palabras, nombre compuesto). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const surname = parts.length >= 4 ? parts[2] : parts[1]
  return ((parts[0]?.[0] ?? '') + (surname?.[0] ?? '') || '?').toUpperCase()
}

/** Logo en data URI: la página la sirve el servidor local, sin acceso a los assets del renderer. */
let logoDataUri: string | null = null
function getLogoDataUri(): string {
  if (logoDataUri === null) {
    try {
      logoDataUri = `data:image/png;base64,${readFileSync(cerpLogoPath).toString('base64')}`
    } catch {
      logoDataUri = ''
    }
  }
  return logoDataUri
}

/** Trae la ventana de la app al frente al terminar el login (Windows puede solo hacer parpadear la barra de tareas). */
function focusAppWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const ICON = (paths: string, size: number, stroke: string, width = 2): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

/**
 * Página que ve el navegador al volver de Auth0. Inline (el servidor HTTP local
 * la sirve tal cual), con el diseño del Desktop: cabecera con logo y paso,
 * tarjeta central, la cuenta que entró y qué hacer ahora.
 */
function renderCallbackPage(opts: { success: boolean; title: string; message: string; account?: CallbackAccount | null }): string {
  const logo = getLogoDataUri()
  const ring = opts.success ? '#fff4e6' : '#fef2f2'
  const circle = opts.success ? '#fe700b' : '#dc2626'
  const mark = opts.success ? '<path d="M20 6 9 17l-5-5"/>' : '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  const account = opts.success && opts.account && (opts.account.name || opts.account.email)
    ? `<div style="width:100%;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #ececec;border-radius:14px;background:#fafafa;text-align:left;">
        <span style="width:38px;height:38px;flex-shrink:0;border-radius:999px;background:#ffe4cc;color:#b32f00;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">${escapeHtml(initialsOf(opts.account.name || opts.account.email))}</span>
        <div style="flex-grow:1;min-width:0;">
          ${opts.account.name ? `<div style="font-size:14px;font-weight:600;">${escapeHtml(opts.account.name)}</div>` : ''}
          ${opts.account.email ? `<div style="font-size:12.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(opts.account.email)}</div>` : ''}
        </div>
        ${opts.account.verified ? `<span style="display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:11.5px;font-weight:600;">${ICON('<path d="M20 6 9 17l-5-5"/>', 12, 'currentColor', 3)}Verificada</span>` : ''}
      </div>`
    : ''
  const next = opts.success
    ? { icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>', title: 'CERP AI ya está abierta en tu escritorio', text: 'Puedes cerrar esta pestaña. Si no ves la aplicación, búscala en la barra de tareas.' }
    : { icon: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', title: 'Vuelve a CERP AI e inténtalo de nuevo', text: 'Pulsa «Iniciar sesión» en la aplicación. Puedes cerrar esta pestaña.' }
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CERP AI · ${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;min-height:100vh;box-sizing:border-box;padding:28px 32px;display:flex;flex-direction:column;background:#f8fafc;color:#1e1e1e;font-family:Inter,'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,sans-serif;">
  <header style="display:flex;align-items:center;gap:10px;">
    ${logo ? `<img src="${logo}" alt="CERP" width="28" height="28" style="object-fit:contain;" />` : ''}
    <span style="font-size:15px;font-weight:600;">CERP AI</span>
  </header>
  <main style="flex-grow:1;display:flex;align-items:center;justify-content:center;padding:32px 0;">
    <div style="width:100%;max-width:420px;box-sizing:border-box;background:#ffffff;border:1px solid #e4e7ec;border-radius:24px;box-shadow:0 8px 28px rgba(16,24,40,0.08);padding:36px 36px 28px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;">
      <span style="width:64px;height:64px;border-radius:999px;background:${ring};display:inline-flex;align-items:center;justify-content:center;">
        <span style="width:44px;height:44px;border-radius:999px;background:${circle};display:inline-flex;align-items:center;justify-content:center;">${ICON(mark, 22, '#ffffff', 2.6)}</span>
      </span>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <h1 style="margin:0;font-size:22px;font-weight:700;">${escapeHtml(opts.title)}</h1>
        <p style="margin:0;font-size:14px;line-height:21px;color:#5a5a5a;">${escapeHtml(opts.message)}</p>
      </div>
      ${account}
      <div style="width:100%;box-sizing:border-box;display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:14px;background:#f1f5f9;text-align:left;">
        <span style="color:#334155;display:inline-flex;margin-top:1px;">${ICON(next.icon, 16, 'currentColor')}</span>
        <div style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-size:13.5px;font-weight:600;">${next.title}</span>
          <span style="font-size:12.5px;line-height:18px;color:#475569;">${next.text}</span>
        </div>
      </div>
    </div>
  </main>
  <footer style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:11.5px;color:#64748b;">
    ${ICON('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', 12, 'currentColor')}
    Conexión segura · CERP Tech
  </footer>
</body>
</html>`
}

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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderCallbackPage({
          success: false,
          title: 'No se pudo iniciar sesión',
          message: 'Ocurrió un error al autenticar.',
        }))
        cleanup()
        reject(new Error(`Auth0 error: ${desc}`))
        return
      }

      if (!code || !codeVerifier) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderCallbackPage({
          success: false,
          title: 'No se pudo iniciar sesión',
          message: 'No se recibió el código de autorización.',
        }))
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderCallbackPage({
            success: false,
            title: 'No se pudo iniciar sesión',
            message: 'No se pudo completar el inicio de sesión.',
          }))
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

        let account: CallbackAccount | null = null
        if (userInfoRes.ok) {
          const userInfo = (await userInfoRes.json()) as Record<string, string>
          tokenStore.setUser({
            name: userInfo.name || userInfo.nickname || '',
            email: userInfo.email || '',
            picture: userInfo.picture,
            companyId: '',
            companyName: '',
          })
          // `email_verified` llega como booleano aunque el resto sea texto.
          account = {
            name: userInfo.name || userInfo.nickname || '',
            email: userInfo.email || '',
            verified: (userInfo as Record<string, unknown>).email_verified === true,
          }
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
        res.end(renderCallbackPage({
          success: true,
          title: 'Sesión iniciada',
          message: 'Tu cuenta quedó vinculada a CERP AI.',
          account,
        }))
        focusAppWindow()

        logger.info('Auth0 login successful')
        cleanup()
        resolve(access_token)
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderCallbackPage({
          success: false,
          title: 'No se pudo iniciar sesión',
          message: 'Ocurrió un error inesperado.',
        }))
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

export function logout(): void {
  tokenStore.clearAll()
  clearApiKey()
  logger.info('User logged out')
}

/**
 * Refresh en vuelo (memoizado): `ensureFreshToken()` y el `onTokenExpired` del
 * httpClient pueden disparar un refresh casi al mismo tiempo (p.ej. una llamada de
 * red en curso recibe 401 justo cuando AUTH_GET_STATUS también decide refrescar).
 * Con Refresh Token Rotation, DOS llamadas concurrentes con el mismo refresh_token
 * revocan la familia entera en Auth0 y desloguean al usuario. Todos los callers
 * comparten esta única promesa mientras hay un refresh en curso.
 */
let inflightRefresh: Promise<string> | null = null

/**
 * Intercambia el refresh token guardado por un accessToken nuevo. Auth0 puede
 * rotar el refresh token (Refresh Token Rotation) — si viene uno nuevo en la
 * respuesta lo persistimos; si no, mantenemos el actual.
 */
export function refreshAccessToken(): Promise<string> {
  if (inflightRefresh) return inflightRefresh

  inflightRefresh = doRefreshAccessToken().finally(() => {
    inflightRefresh = null
  })
  return inflightRefresh
}

async function doRefreshAccessToken(): Promise<string> {
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
 * Usar esto en cualquier punto que vaya a hacer una llamada de red real.
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
    // El accessToken guardado ya está muerto (venció y el refresh falló) — lo
    // limpiamos para que httpClient no lo siga mandando en requests directos
    // (uploadFile/downloadFile no pasan por ensureFreshToken) hasta el próximo login.
    tokenStore.clearAccessToken()
    return null
  }
}
