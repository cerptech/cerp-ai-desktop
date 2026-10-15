import { tool } from '@anthropic-ai/claude-agent-sdk'
import { shell } from 'electron'
import { z } from 'zod'
import { CompanyChangedError, HttpClient, HttpError, NoActiveCompanyError, SessionRevokedError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'
import { describeAppAction, toolkitDisplayName } from './appActionCard'
import type { AskUserQuestionItem } from '../ipc/types'

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
 *
 * # Confirmación en el handler (como el cronograma)
 *
 * El agente corre con `permissionMode: 'bypassPermissions'`: el SDK no le pide
 * permiso a nadie. Por eso `run_app_tool` pregunta DENTRO del handler, sin
 * depender de que el modelo quiera preguntar (también cubre a un subagente):
 *   1. Pregunta al core si la acción escribe (`get_app_tool_schema` →
 *      `necesitaConfirmacion`). Solo `false` explícito evita la tarjeta: si no se
 *      puede leer, se confirma (default del writeGuard).
 *   2. Arma la tarjeta con el input YA validado (`appActionCard.ts`) y la muestra
 *      con `waitForAnswer`: «Confirmar» / «Cancelar».
 *   3. Solo con «Confirmar» exacto hace el POST con la aprobación
 *      (`buildApproval`). Cancelar, «Otro…» o un fallo al preguntar = NO hay POST.
 * El core vuelve a exigir la confirmación (403 APP_ACTION_NEEDS_CONFIRMATION):
 * son dos candados independientes, porque un email enviado no se deshace.
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

const ToolSlug = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/, 'slug invalido: letras, numeros y guion bajo (ej: GMAIL_SEND_EMAIL)')
  .max(120)
  .describe('Slug exacto de la acción, ej: "GMAIL_SEND_EMAIL".')

const GetAppToolSchemaSchema = z.object({ tool: ToolSlug })

const RunAppToolSchema = z.object({
  tool: ToolSlug,
  input: z
    .record(z.string(), z.unknown())
    .describe('Parámetros de la acción, con los nombres exactos que devolvió get_app_tool_schema.'),
})

const ConnectAppSchema = z.object({
  app: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'slug de app invalido (ej: "gmail", "googlecalendar")')
    .max(60)
    .describe('Slug de la app a conectar, ej: "gmail", "googlecalendar", "notion".'),
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

/** Código de error del core (`{ error: { code } }`), si lo hay. */
function coreErrorCode(err: unknown): string | undefined {
  if (!(err instanceof HttpError)) return undefined
  const body = err.body as { error?: { code?: unknown } } | undefined
  return typeof body?.error?.code === 'string' ? body.error.code : undefined
}

/**
 * Lo que viaja para decirle al core que el usuario confirmó. Hoy el booleano
 * `approved` (modo «dual», como scheduleTools). Cuando el core emita una
 * aprobación sellada (ADR 021, borrador), se cambia SOLO acá.
 */
function buildApproval(): { approved: true } {
  return { approved: true }
}

/**
 * POST /ai-tools/:name con `{ input }` (sin companyId) → el `result` (string) del core.
 * `approval` solo lo pasa `run_app_tool` después de que el usuario pulsó «Confirmar».
 */
async function callCoreAppTool(
  httpClient: HttpClient,
  name: string,
  input: Record<string, unknown>,
  approval?: ReturnType<typeof buildApproval>,
): Promise<string> {
  const res = await httpClient.post<{ result?: unknown }>(`/ai-tools/${encodeURIComponent(name)}`, { input, ...approval })
  const result = res?.result
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

// ── Confirmación (waitForAnswer) ─────────────────────────────────────────────

const CONFIRM_OPTION = 'Confirmar'
const CANCEL_OPTION = 'Cancelar'
const MAX_QUESTION_CHARS = 1500

type ConfirmOutcome = { confirmed: true } | { confirmed: false; reason: 'cancelled_by_user' | 'not_confirmed'; mensaje: string }

/** La pregunta «Confirmar» / «Cancelar» con la tarjeta armada desde el input real. */
function confirmQuestion(slug: string, input: Record<string, unknown>, toolkit: string): AskUserQuestionItem {
  const card = describeAppAction(slug, input, toolkit)
  const campos = card.fields.map((f) => `${f.label}: ${f.value}`).join(' · ')
  // `question` es el texto plano (historial, logs y fallback del widget); la ficha va en `card`.
  const text = `${card.destructive ? 'ACCIÓN QUE BORRA. ' : ''}${card.title}${campos ? ` — ${campos}` : ''}. ¿Confirmás esta acción?`
  return {
    question: text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS - 1)}…` : text,
    header: toolkitDisplayName(toolkit).slice(0, 24),
    multiSelect: false,
    options: [
      { label: CONFIRM_OPTION, description: `Se ejecuta en ${toolkitDisplayName(toolkit)} con estos datos.` },
      { label: CANCEL_OPTION, description: 'No se envía ni se modifica nada.' },
    ],
    card: { title: card.title, fields: card.fields, preview: card.preview, destructive: card.destructive },
  }
}

/**
 * Pregunta en la conversación del usuario y espera. Solo «Confirmar» exacto
 * confirma: cancelar, «Otro: …», vacío o cualquier fallo al preguntar = no
 * confirmado. Nunca lanza.
 */
async function confirmWithUser(conversationId: string, question: AskUserQuestionItem, logTag: string): Promise<ConfirmOutcome> {
  let answer: string
  try {
    const answers = await waitForAnswer(conversationId, { questions: [question] })
    const raw = answers[question.question] ?? Object.values(answers)[0]
    answer = (Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`${logTag}: sin confirmacion (${message}) — no se ejecuta`)
    return {
      confirmed: false,
      reason: 'not_confirmed',
      mensaje: `No se pudo pedir la confirmación al usuario (${message}). La acción NO se ejecutó.`,
    }
  }

  if (answer === CONFIRM_OPTION) return { confirmed: true }

  const otro = answer.startsWith('Otro:') ? answer.slice('Otro:'.length).trim() : ''
  logger.info(`${logTag}: el usuario no confirmo (${answer || 'sin respuesta'})`)
  return {
    confirmed: false,
    reason: 'cancelled_by_user',
    mensaje: otro
      ? `El usuario no confirmó y respondió: "${otro}". No se envió ni se modificó nada; preguntale qué cambiar.`
      : 'El usuario canceló la acción. No se envió ni se modificó nada; no la reintentes sin que lo pida.',
  }
}

/**
 * ¿La acción necesita confirmación? Lo decide el CORE (`necesitaConfirmacion` de
 * get_app_tool_schema). Devuelve también la app y, si el slug no existe, el texto
 * del core para el modelo (sin POST de ejecución).
 */
async function readActionInfo(
  httpClient: HttpClient,
  slug: string,
): Promise<{ needsConfirmation: boolean; toolkit: string } | { notFound: string }> {
  const fallbackToolkit = slug.split('_')[0]?.toLowerCase() ?? ''
  const raw = await callCoreAppTool(httpClient, 'get_app_tool_schema', { tool: slug })
  let parsed: { app?: unknown; necesitaConfirmacion?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    // El core responde texto plano cuando el slug no existe ("No existe una acción…").
    return { notFound: raw }
  }
  return {
    // Fail-closed: solo un `false` explícito evita la tarjeta.
    needsConfirmation: parsed?.necesitaConfirmacion !== false,
    toolkit: typeof parsed?.app === 'string' && parsed.app ? parsed.app : fallbackToolkit,
  }
}

/** Resultado de la tool cuando no hubo confirmación: `{ applied: false, reason }`, sin POST. */
function unconfirmedResult(outcome: Extract<ConfirmOutcome, { confirmed: false }>) {
  const payload = { applied: false, reason: outcome.reason, mensaje: outcome.mensaje }
  return outcome.reason === 'not_confirmed'
    ? { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true }
    : textResult(JSON.stringify(payload))
}

// ── run_app_tool ─────────────────────────────────────────────────────────────

function createRunAppTool(httpClient: HttpClient, conversationId: string) {
  return tool(
    'run_app_tool',
    'Ejecuta una acción en una app conectada del usuario. Las acciones que envían o modifican algo hacia afuera (mandar un email, crear un evento, subir un archivo) requieren la confirmación explícita del usuario: el sistema le muestra una tarjeta con el detalle real y decide «Confirmar» o «Cancelar» — no le preguntes vos antes. ' +
      'No prometas que algo se envió hasta que esta tool devuelva éxito. Si el usuario cancela (applied:false, "cancelled_by_user"), no reintentes sin que lo pida.',
    RunAppToolSchema as any,
    async (args: Record<string, unknown>) => {
      const parsed = RunAppToolSchema.safeParse(args)
      if (!parsed.success) return errorResult(describeZodError(parsed.error))
      const { tool: slug, input } = parsed.data
      const logTag = `run_app_tool[${slug}]`

      let info: Awaited<ReturnType<typeof readActionInfo>>
      try {
        info = await readActionInfo(httpClient, slug)
      } catch (err) {
        const message = describeCoreError(err)
        logger.error(`${logTag}: no se pudo leer la acción: ${message}`)
        return errorResult(message)
      }
      if ('notFound' in info) return errorResult(info.notFound)

      const ask = () => confirmWithUser(conversationId, confirmQuestion(slug, input, info.toolkit), logTag)

      let approval: ReturnType<typeof buildApproval> | undefined
      if (info.needsConfirmation) {
        const outcome = await ask()
        if (!outcome.confirmed) return unconfirmedResult(outcome)
        approval = buildApproval()
      }

      try {
        const result = await callCoreAppTool(httpClient, 'run_app_tool', { tool: slug, input }, approval)
        logger.info(`${logTag} OK: ${result.substring(0, 200)}`)
        return textResult(result)
      } catch (err) {
        // El core es la autoridad: si exige confirmación que no pedimos (tags que
        // cambiaron), se le pregunta al usuario y se reintenta UNA vez con su OK.
        if (!approval && coreErrorCode(err) === 'APP_ACTION_NEEDS_CONFIRMATION') {
          const outcome = await ask()
          if (!outcome.confirmed) return unconfirmedResult(outcome)
          try {
            const result = await callCoreAppTool(httpClient, 'run_app_tool', { tool: slug, input }, buildApproval())
            logger.info(`${logTag} OK (tras confirmar): ${result.substring(0, 200)}`)
            return textResult(result)
          } catch (retryErr) {
            const message = describeCoreError(retryErr)
            logger.error(`${logTag} FAILED: ${message}`)
            return errorResult(message)
          }
        }
        const message = describeCoreError(err)
        logger.error(`${logTag} FAILED: ${message}`)
        return errorResult(message)
      }
    },
    // Puede mandar algo hacia afuera: nunca en paralelo (una tarjeta a la vez).
    { annotations: { readOnlyHint: false, destructiveHint: true } },
  )
}

// ── connect_app ──────────────────────────────────────────────────────────────

/** Solo se abren enlaces https (el que devuelve Composio por el core). */
function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function createConnectAppTool(httpClient: HttpClient) {
  return tool(
    'connect_app',
    'Abre en el navegador del usuario la autorización para conectar una app que todavía no tiene vinculada. Úsala cuando run_app_tool falle por falta de conexión o cuando el usuario pida usar una app que no aparece en list_connected_apps. ' +
      'Después pedile al usuario que autorice en el navegador y te avise; recién ahí confirmá con list_connected_apps. También puede conectarla él desde el botón «Apps» de la barra superior.',
    ConnectAppSchema as any,
    async (args: Record<string, unknown>) => {
      const parsed = ConnectAppSchema.safeParse(args)
      if (!parsed.success) return errorResult(describeZodError(parsed.error))
      const { app } = parsed.data

      let raw: string
      try {
        raw = await callCoreAppTool(httpClient, 'connect_app', { app })
      } catch (err) {
        const message = describeCoreError(err)
        logger.error(`MCP connect_app FAILED: ${message}`)
        return errorResult(message)
      }

      let enlace: unknown
      try {
        enlace = (JSON.parse(raw) as { enlace?: unknown }).enlace
      } catch {
        // Texto plano del core: app vetada o enlace imposible de generar.
        return errorResult(raw)
      }
      if (!isSafeExternalUrl(enlace)) {
        logger.error(`MCP connect_app: el core no devolvió un enlace https para ${app}`)
        return errorResult(`No se pudo generar el enlace de conexión para "${app}".`)
      }

      try {
        await shell.openExternal(enlace)
      } catch (err) {
        logger.warn(`MCP connect_app: no se pudo abrir el navegador (${err instanceof Error ? err.message : String(err)})`)
        return textResult(
          JSON.stringify({
            app,
            abierto: false,
            enlace,
            instruccion: 'No se pudo abrir el navegador. Pasale este enlace al usuario para que autorice la app y te avise cuando termine.',
          }),
        )
      }
      logger.info(`MCP connect_app: navegador abierto para ${app}`)
      return textResult(
        JSON.stringify({
          app,
          abierto: true,
          instruccion: `Se abrió el navegador para que el usuario autorice ${toolkitDisplayName(app)}. Decile que lo haga y que te avise cuando termine; después confirmá con list_connected_apps.`,
        }),
      )
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )
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
 * core, así `mcp__cerp__*` las cubre). `conversationId` es la conversación que
 * corre el agente: la tarjeta de `run_app_tool` se muestra en esa.
 */
export function createAppTools(httpClient: HttpClient, conversationId: string) {
  const reads = APP_READ_TOOLS.map((spec) =>
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

  return [...reads, createRunAppTool(httpClient, conversationId), createConnectAppTool(httpClient)]
}
