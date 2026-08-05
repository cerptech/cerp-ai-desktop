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
  private isRefreshing = false

  constructor(getToken: () => string | null, onTokenExpired?: () => Promise<void>) {
    this.getToken = getToken
    this.onTokenExpired = onTokenExpired
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

    if (res.status === 401 && !retried && this.onTokenExpired && !this.isRefreshing) {
      this.isRefreshing = true
      try {
        await this.onTokenExpired()
        return this.uploadFile(path, formData, true)
      } catch { /* fall through */ } finally {
        this.isRefreshing = false
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${body}`)
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

    if (res.status === 401 && !retried && this.onTokenExpired && !this.isRefreshing) {
      this.isRefreshing = true
      try {
        await this.onTokenExpired()
        return this.downloadFile(path, savePath, true)
      } catch { /* fall through */ } finally {
        this.isRefreshing = false
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${body}`)
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
    // isRefreshing guard prevents re-entry: fetchApiKey also calls request(),
    // which would otherwise trigger onTokenExpired recursively on a repeated 401.
    if (res.status === 401 && !retried && this.onTokenExpired && !this.isRefreshing) {
      this.isRefreshing = true
      try {
        await this.onTokenExpired()
        return this.request(method, path, data, true)
      } catch {
        // Refresh failed — fall through to throw original error
      } finally {
        this.isRefreshing = false
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, parseErrorBody(text), `API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<T>
  }
}
