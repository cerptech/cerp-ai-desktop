function getApiBaseUrl(): string {
  return process.env.CERP_API_BASE_URL || 'http://localhost:8080/api'
}

export class HttpClient {
  private getToken: () => string | null

  constructor(getToken: () => string | null) {
    this.getToken = getToken
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

  async request<T = unknown>(method: string, path: string, data?: unknown): Promise<T> {
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

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }
}
