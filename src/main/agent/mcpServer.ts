import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { toolSchemas } from './toolDefinitions'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Creates an in-process MCP server that exposes the 16 CERP tools.
 * Each tool calls the CERP backend REST API using the Auth0 token.
 */
export function createCerpMcpServer(httpClient: HttpClient) {
  return createSdkMcpServer({
    name: 'cerp',
    version: '1.0.0',
    tools: Object.entries(toolSchemas).map(([name, def]) =>
      tool(name, def.description, def.schema, async (args: Record<string, unknown>) => {
        try {
          const url = buildUrl(def.endpoint, args)
          logger.info(`MCP tool ${name} → GET ${url}`)
          const data = await httpClient.get(url)
          const text = JSON.stringify(data, null, 2)
          logger.info(`MCP tool ${name} OK: ${text.substring(0, 200)}`)
          return { content: [{ type: 'text' as const, text }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`MCP tool ${name} FAILED: ${message}`)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] }
        }
      }),
    ),
  })
}

/**
 * Builds API URL from endpoint template + args.
 * - Path params like :projectId are replaced from args
 * - Remaining args become query string params
 */
function buildUrl(endpoint: string, args: Record<string, unknown>): string {
  const queryParams: Record<string, string> = {}
  let path = endpoint

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue

    const placeholder = `:${key}`
    if (path.includes(placeholder)) {
      path = path.replace(placeholder, String(value))
    } else {
      queryParams[key] = String(value)
    }
  }

  const qs = new URLSearchParams(queryParams).toString()
  return qs ? `${path}?${qs}` : path
}
