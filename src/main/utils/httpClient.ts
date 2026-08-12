function getApiBaseUrl(): string {
  return process.env.CERP_API_BASE_URL || 'https://production-cerp-server-1060273677691.europe-west1.run.app/api'
}

/**
 * Error de API con el status HTTP y el body parseado (si es JSON) adjuntos.
 * Permite a los callers distinguir casos específicos (p.ej. 402 NO_CREDITS)
 * sin tener que parsear el mensaje de texto plano.
 */
export class HttpError extends Error {
  readonly status: number
  readonly body?: unknown

  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

function parseErrorBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export class HttpClient {
  private getToken: () => string | null
  private onTokenExpired?: () => Promise<void>
  /** Promesa del refresh en vuelo — reemplaza al viejo guard booleano `isRefreshing`. */
  private refreshPromise: Promise<void> | null = null

  constructor(getToken: () => string | null, onTokenExpired?: () => Promise<void>) {
    this.getToken = getToken
    this.onTokenExpired = onTokenExpired
  }

  /**
   * Memoiza el refresh en vuelo: si dos (o más) requests concurrentes reciben 401 a
   * la vez, todas comparten UNA sola llamada a `onTokenExpired` en vez de disparar
   * una por cada 401. Antes, el guard booleano `isRefreshing` hacía que el SEGUNDO
   * 401 concurrente se topara con `isRefreshing === true`, se saltara el refresh por
   * completo y cayera directo al `throw HttpError(401)` — que los handlers mapean a
   * `error:'auth'`, y la UI lo renderiza vacío asumiendo (incorrectamente) que el
   * modal global de sesión expirada ya está abierto. Ahora cada caller espera esta
   * misma promesa y reintenta su propia request una vez con el token nuevo.
   *
   * La asignación a `this.refreshPromise` ocurre de forma síncrona (antes de que
   * corra cualquier `await` dentro de `onTokenExpired`), así que no hay ventana en
   * la que un 401 posterior en el mismo tick vea `refreshPromise` todavía en null.
   */
  private refreshTokenOnce(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          await this.onTokenExpired?.()
        } finally {
          this.refreshPromise = null
        }
      })()
    }
    return this.refreshPromise
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request('GET', path) as Promise<T>
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    return this.request('POST', path, data) as Promise<T>
  }

  async patch<T = unknown>(path: string, data?: unknown): Promise<T> {
    return this.request('PATCH', path, data) as Promise<T>
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request('DELETE', path) as Promise<T>
  }

  async uploadFile<T = unknown>(path: string, formData: FormData, retried = false): Promise<T> {
    const token = this.getToken()
    if (!token) throw new Error('No auth token available')

    const url = `${getApiBaseUrl()}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-CERP-Desktop': '1',
        // Do NOT set Content-Type — fetch sets it automatically with the multipart boundary
      },
      body: formData,
    })

    if (res.status === 401 && !retried && this.onTokenExpired) {
      try {
        await this.refreshTokenOnce()
        return this.uploadFile(path, formData, true)
      } catch { /* fall through */ }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, parseErrorBody(text), `API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<T>
  }

  async downloadFile(path: string, savePath: string, retried = false): Promise<void> {
    const token = this.getToken()
    if (!token) throw new Error('No auth token available')

    const url = `${getApiBaseUrl()}${path}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-CERP-Desktop': '1',
      },
    })

    if (res.status === 401 && !retried && this.onTokenExpired) {
      try {
        await this.refreshTokenOnce()
        return this.downloadFile(path, savePath, true)
      } catch { /* fall through */ }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, parseErrorBody(text), `API error ${res.status}: ${text}`)
    }

    const { writeFileSync } = require('fs')
    const buffer = Buffer.from(await res.arrayBuffer())
    writeFileSync(savePath, buffer)
  }

  async request<T = unknown>(method: string, path: string, data?: unknown, retried = false): Promise<T> {
    const token = this.getToken()
    if (!token) throw new Error('No auth token available')

    const url = `${getApiBaseUrl()}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-CERP-Desktop': '1',
      },
      body: data ? JSON.stringify(data) : undefined,
    })

    // Retry once on 401 — token may have expired during a long session.
    // refreshTokenOnce() memoiza el refresh en vuelo: concurrent 401s (incluida la
    // reentrancy de fetchApiKey, que también llama a request()) comparten la misma
    // promesa en vez de disparar un refresh por cada una.
    if (res.status === 401 && !retried && this.onTokenExpired) {
      try {
        await this.refreshTokenOnce()
        return this.request(method, path, data, true)
      } catch {
        // Refresh failed — fall through to throw original error
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, parseErrorBody(text), `API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<T>
  }
}
