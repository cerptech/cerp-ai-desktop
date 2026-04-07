function getApiBaseUrl(): string {
  return process.env.CERP_API_BASE_URL || 'https://production-cerp-server-1060273677691.europe-west1.run.app/api'
}

export class HttpClient {
  private getToken: () => string | null
  private onTokenExpired?: () => Promise<void>

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

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request('DELETE', path) as Promise<T>
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

    // Retry once on 401 — token may have expired during a long session
    if (res.status === 401 && !retried && this.onTokenExpired) {
      try {
        await this.onTokenExpired()
        return this.request(method, path, data, true)
      } catch {
        // Refresh failed — throw original error
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }
}
