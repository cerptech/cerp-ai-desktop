import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { toolSchemas } from './toolDefinitions'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Creates an in-process MCP server with all CERP tools.
 * companyId is injected automatically into write operations.
 */
export function createCerpMcpServer(httpClient: HttpClient, companyId: string | null, userId: string | null) {
  return createSdkMcpServer({
    name: 'cerp',
    version: '2.0.0',
    tools: Object.entries(toolSchemas).map(([name, def]) =>
      tool(name, def.description, def.schema, async (args: Record<string, unknown>) => {
        try {
          const { url, body } = buildRequest(def.endpoint, def.method, args)
          logger.info(`MCP ${def.method} ${name} → ${url}`)

          // Auto-inject companyId into all operations
          let requestBody = body
          let requestUrl = url
          if (companyId) {
            if (def.method === 'GET') {
              // For GET, add companyId as query param
              const separator = requestUrl.includes('?') ? '&' : '?'
              requestUrl = `${requestUrl}${separator}companyId=${companyId}`
            } else if (def.method !== 'DELETE') {
              // For POST/PUT/PATCH, add companyId + user (owner_id) to body
              requestBody = { ...(requestBody || {}), companyId, user: userId ? { _id: userId } : undefined }
            }
          }

          let data: unknown

          switch (def.method) {
            case 'GET':
              data = await httpClient.get(requestUrl)
              break
            case 'POST':
              data = await httpClient.post(url, requestBody)
              break
            case 'PUT':
              data = await httpClient.request('PUT', url, requestBody)
              break
            case 'PATCH':
              data = await httpClient.request('PATCH', url, requestBody)
              break
            case 'DELETE':
              data = await httpClient.request('DELETE', url)
              break
          }

          const text = JSON.stringify(data, null, 2)
          logger.info(`MCP ${name} OK: ${text.substring(0, 200)}`)
          return { content: [{ type: 'text' as const, text }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`MCP ${name} FAILED: ${message}`)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] }
        }
      }),
    ),
  })
}

function buildRequest(
  endpoint: string,
  method: string,
  args: Record<string, unknown>,
): { url: string; body?: Record<string, unknown> } {
  const remaining: Record<string, unknown> = {}
  let path = endpoint

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue

    const placeholder = `:${key}`
    if (path.includes(placeholder)) {
      path = path.replace(placeholder, String(value))
    } else {
      remaining[key] = value
    }
  }

  if (method === 'GET') {
    const queryParams: Record<string, string> = {}
    for (const [key, value] of Object.entries(remaining)) {
      queryParams[key] = String(value)
    }
    const qs = new URLSearchParams(queryParams).toString()
    return { url: qs ? `${path}?${qs}` : path }
  }

  return {
    url: path,
    body: Object.keys(remaining).length > 0 ? remaining : undefined,
  }
}
