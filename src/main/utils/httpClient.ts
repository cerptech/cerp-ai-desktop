const API_BASE_URL = process.env.CERP_API_BASE_URL || 'http://localhost:8080/api'

export class HttpClient {
  private getToken: () => string | null

  constructor(getToken: () => string | null) {
    this.getToken = getToken
  }

  async get<T = unknown>(path: string): Promise<T> {
    const token = this.getToken()
    if (!token) throw new Error('No auth token available')

    const url = `${API_BASE_URL}${path}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-CERP-Desktop': '1',
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`API error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    const token = this.getToken()
    if (!token) throw new Error('No auth token available')

    const url = `${API_BASE_URL}${path}`
    const res = await fetch(url, {
      method: 'POST',
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
