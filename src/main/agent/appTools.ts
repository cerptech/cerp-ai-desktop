import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { CompanyChangedError, HttpClient, HttpError, NoActiveCompanyError, SessionRevokedError } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tools de APPS CONECTADAS (Composio: Gmail, Calendar, Drive, Notion, Slack…)
 * para el cliente desktop.
 *
 * Son las MISMAS 5 meta-tools que usa CERP IA web (`cerp-server/src/agents/apps/
 * tools.ts`, `APP_TOOL_DEFINITIONS`) y siempre las mismas para todos los
 * usuarios: el agente no recibe una tool por app, descubre las acciones en
 * tiempo de ejecución (`search_apps_tools`). Así el toolset no cambia según qué
 * conectó cada uno.
 *
 * # Contrato con el core
 *
 * Igual que el cronograma (`scheduleTools.ts`): `POST /api/ai-tools/:name` con
 * el Bearer del usuario y body `{ input }` → 200 `{ result: string }` (el mismo
 * texto que recibe el canal web). 403 permiso (`integrations`) o confirmación
 * faltante, 404 tool desconocida, 429 cuota diaria. Nunca el secreto de
 * servicio de cerp-ai-service (`/internal/ai/composio/*`): no puede vivir en un
 * cliente instalado.
 *
 * # Sin companyId (ADR 007, regla 1)
 *
 * Estas tools no pasan por la inyección automática de `companyId`/`user` de
 * mcpServer.ts. El core saca la empresa y el usuario del token, y con ellos
 * arma el usuario de Composio (`empresa:usuario`).
 *
 * Los esquemas Zod son un ESPEJO escrito a mano de `APP_TOOL_DEFINITIONS`: si el
 * core cambia un parámetro, hay que llevarlo a este archivo.
 */

// ── Esquemas (espejo de APP_TOOL_DEFINITIONS) ─────────────────────────────────

const ListConnectedAppsSchema = z.object({})

const SearchAppsToolsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe('Caso de uso a buscar, ej: "enviar un email con adjunto" o "crear evento en el calendario".'),
  app: z
    .string()
    .max(60)
    .optional()
    .describe('Opcional. Slug de la app para acotar la búsqueda, ej: "gmail", "googlecalendar", "notion".'),
})

const GetAppToolSchemaSchema = z.object({
  tool: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'slug invalido: letras, numeros y guion bajo (ej: GMAIL_SEND_EMAIL)')
    .max(120)
    .describe('Slug exacto de la acción, ej: "GMAIL_SEND_EMAIL".'),
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(error: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true }
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; ')
}

/**
 * Texto para el modelo a partir de un fallo. 403 y 429 los redacta el core PARA
 * el modelo (permiso, confirmación, cuota): se pasan tal cual para que se lo
 * explique al usuario. Los errores de sesión/empresa y el timeout ya traen su
 * mensaje para el modelo. El resto, genérico (como el canal web).
 */
function describeCoreError(err: unknown): string {
  if (err instanceof CompanyChangedError || err instanceof NoActiveCompanyError || err instanceof SessionRevokedError) {
    return err.message
  }
  if (err instanceof HttpError) {
    if (err.status === 403 || err.status === 429) {
      const body = err.body as { error?: { message?: string } | string } | undefined
      const message = typeof body?.error === 'string' ? body.error : body?.error?.message
      if (message) return message
    }
    return 'La acción en la app conectada no está disponible ahora mismo.'
  }
  return err instanceof Error ? err.message : String(err)
}

/** POST /ai-tools/:name con `{ input }` (sin companyId) → el `result` (string) del core. */
async function callCoreAppTool(httpClient: HttpClient, name: string, input: Record<string, unknown>): Promise<string> {
  const res = await httpClient.post<{ result?: unknown }>(`/ai-tools/${encodeURIComponent(name)}`, { input })
  const result = res?.result
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

interface AppReadToolSpec {
  name: string
  description: string
  schema: z.ZodObject
}

// ── Definiciones: LECTURA ────────────────────────────────────────────────────
// Descripciones = las de APP_TOOL_DEFINITIONS (lo que ve el modelo en web).

const APP_READ_TOOLS: AppReadToolSpec[] = [
  {
    name: 'list_connected_apps',
    description:
      'Lista las apps que el usuario YA tiene conectadas. Llamala ANTES de decir que algo no está conectado o de ofrecer un enlace de conexión: es la única forma de saberlo. Nunca supongas que una app no está conectada.',
    schema: ListConnectedAppsSchema,
  },
  {
    name: 'search_apps_tools',
    description:
      'Busca acciones disponibles en las apps que el usuario tiene conectadas (Gmail, Calendar, Drive, Sheets, Outlook, Notion, Slack y cientos más). Úsala cuando el usuario pida algo que involucre una app externa, ANTES de intentar ejecutar nada. Describe el caso de uso en lenguaje natural, no adivines el nombre de la acción.',
    schema: SearchAppsToolsSchema,
  },
  {
    name: 'get_app_tool_schema',
    description:
      'Devuelve los parámetros exactos que necesita una acción encontrada con search_apps_tools. Llamala siempre antes de run_app_tool: los nombres de los campos varían entre apps y no se pueden adivinar.',
    schema: GetAppToolSchemaSchema,
  },
]

/**
 * Tools de apps conectadas del servidor MCP `cerp` (mismos nombres que en el
 * core, así `mcp__cerp__*` las cubre).
 */
export function createAppTools(httpClient: HttpClient) {
  return APP_READ_TOOLS.map((spec) =>
    tool(
      spec.name,
      spec.description,
      spec.schema as any,
      async (args: Record<string, unknown>) => {
        const parsed = spec.schema.safeParse(args)
        if (!parsed.success) return errorResult(describeZodError(parsed.error))

        try {
          const result = await callCoreAppTool(httpClient, spec.name, parsed.data as Record<string, unknown>)
          logger.info(`MCP ${spec.name} OK: ${result.substring(0, 200)}`)
          return textResult(result)
        } catch (err) {
          const message = describeCoreError(err)
          logger.error(`MCP ${spec.name} FAILED: ${message}`)
          return errorResult(message)
        }
      },
      { annotations: { readOnlyHint: true, destructiveHint: false } },
    ),
  )
}
