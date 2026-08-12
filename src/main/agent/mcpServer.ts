import { createHash, randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toolSchemas } from './toolDefinitions'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'
import { startQuoteHeartbeat, stopQuoteHeartbeat } from './quoteHeartbeat'
import { emitQuoteFirewallEvent } from './quoteEventsBridge'
import { emitHtmlCanvasEvent } from './htmlCanvasBridge'

// ── create_tasks_batch: chunking + claves idempotentes ───────────────────────

interface BatchTaskArg {
  key?: string
  name: string
  startDate: string
  endDate: string
  status: string
  description?: string
  parentKey?: string
  parentTaskId?: string
}

const TASKS_BATCH_CHUNK_SIZE = 50

/**
 * Clave idempotente para una tarea sin key explícita: hash estable de los campos
 * que la identifican. Determinística entre reintentos, siempre que el agente
 * re-mande el lote con los mismos datos (por eso el schema pide reusar keys).
 */
function deriveTaskKey(t: BatchTaskArg): string {
  const basis = [t.name, t.startDate, t.endDate, t.parentKey ?? t.parentTaskId ?? ''].join('|')
  return 'k-' + createHash('sha1').update(basis).digest('hex').slice(0, 16)
}

/**
 * Ejecuta la carga masiva contra el endpoint batch del backend, troceando en
 * bloques de 50 (secuencial: la numeración jerárquica no tolera carreras) y
 * mapeando key→clientKey / parentKey→parentClientKey. Reanudable: el backend
 * saltea (skipped) las claves ya creadas, así que reintentar el MISMO lote
 * retoma donde quedó sin duplicar.
 */
async function runTasksBatch(
  args: { projectId: string; tasks: BatchTaskArg[] },
  httpClient: HttpClient,
  companyId: string | null,
  userId: string | null
): Promise<unknown> {
  const { projectId, tasks } = args

  // Clave definitiva: explícita o derivada; sufijo -2/-3… si colisiona dentro del
  // lote. `used` garantiza unicidad del resultado FINAL (una key explícita "X-2"
  // podría chocar con el sufijo generado para la segunda "X").
  const used = new Set<string>()
  const withKeys = tasks.map((t) => {
    const base = (t.key && t.key.trim()) || deriveTaskKey(t)
    let key = base
    let n = 1
    while (used.has(key)) {
      n++
      key = `${base}-${n}`
    }
    used.add(key)
    return { ...t, key }
  })

  // Todo parentKey debe apuntar a una key definitiva del lote (los padres
  // preexistentes van por parentTaskId, no por parentKey).
  const finalKeys = new Set(withKeys.map((t) => t.key))
  for (const t of withKeys) {
    if (t.parentKey && !finalKeys.has(t.parentKey)) {
      return {
        error: `parentKey '${t.parentKey}' no coincide con ninguna key del lote. Los padres deben aparecer ANTES que sus hijos y conservar su key exacta.`,
      }
    }
  }

  const summary = { total: tasks.length, created: 0, skipped: 0, errors: 0 }
  const results: unknown[] = []
  const totalChunks = Math.ceil(withKeys.length / TASKS_BATCH_CHUNK_SIZE)

  for (let i = 0; i < withKeys.length; i += TASKS_BATCH_CHUNK_SIZE) {
    const chunk = withKeys.slice(i, i + TASKS_BATCH_CHUNK_SIZE)
    const chunkNo = i / TASKS_BATCH_CHUNK_SIZE + 1
    logger.info(`create_tasks_batch chunk ${chunkNo}/${totalChunks} (${chunk.length} tareas)`)
    try {
      const data = (await httpClient.post(`/projects/${projectId}/tasks/batch`, {
        tasks: chunk.map((t) => ({
          clientKey: t.key,
          name: t.name,
          startDate: t.startDate,
          endDate: t.endDate,
          status: t.status,
          description: t.description,
          parentClientKey: t.parentKey,
          parentTaskId: t.parentTaskId,
        })),
        companyId: companyId ?? undefined,
        user: userId ? { _id: userId } : undefined,
      })) as { summary?: { created?: number; skipped?: number; errors?: number }; results?: unknown[] } | null
      summary.created += data?.summary?.created ?? 0
      summary.skipped += data?.summary?.skipped ?? 0
      summary.errors += data?.summary?.errors ?? 0
      if (Array.isArray(data?.results)) results.push(...data.results)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Backend sin el endpoint batch (deploy viejo): reintentar sería un loop
      // infinito — indicar el fallback 1×1 en vez de la instrucción de reanudación.
      if (/\b404\b/.test(message)) {
        return {
          summary,
          results,
          error:
            'El servidor CERP de esta empresa todavía no soporta la carga masiva de tareas (endpoint no encontrado). ' +
            'NO reintentes create_tasks_batch: crea las tareas restantes de a una con create_task.',
        }
      }
      return {
        summary,
        results,
        error:
          `La carga se interrumpió en el bloque ${chunkNo}/${totalChunks}: ${message}. ` +
          'Volvé a llamar create_tasks_batch con el MISMO lote completo para retomar: las tareas ya creadas se saltan solas (skipped).',
      }
    }
  }

  return { summary, results }
}

// ── attach_budget_pdf Zod schema ─────────────────────────────────────────────

const AttachBudgetPdfSchema = z.object({
  projectId: z.string().describe('ID del proyecto al que pertenece el presupuesto.'),
  budgetId: z.string().describe('ID del presupuesto al que se adjunta el PDF.'),
  filePath: z.string().describe('Ruta absoluta del PDF en el disco local del usuario.'),
  description: z.string().optional().describe('Descripcion breve del archivo (ej: "Condiciones generales", "Plano de planta").'),
})

const DownloadBudgetAttachmentSchema = z.object({
  projectId: z.string().describe('ID del proyecto.'),
  attachmentId: z.string().describe('ID del adjunto a descargar (obtenido de get_budget_attachments).'),
  savePath: z.string().describe('Ruta absoluta local donde guardar el PDF descargado.'),
})

// ── ask_user_question Zod schema ──────────────────────────────────────────────

const AskUserQuestionOptionSchema = z.object({
  label: z.string().describe('Texto corto de la opcion que ve el usuario (1-5 palabras).'),
  description: z.string().describe('Explicacion adicional de la opcion.'),
})

const AskUserQuestionItemSchema = z.object({
  question: z.string().describe('La pregunta completa terminando en signo de interrogacion.'),
  header: z.string().max(12).describe('Etiqueta corta tipo chip (max 12 chars). Ej: "IVA", "Cliente".'),
  multiSelect: z.boolean().describe('true si el usuario puede elegir varias opciones.'),
  options: z
    .array(AskUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe('Entre 2 y 4 opciones. El sistema agrega "Otro..." automaticamente.'),
})

const AskUserQuestionSchema = z.object({
  questions: z
    .array(AskUserQuestionItemSchema)
    .min(1)
    .max(4)
    .describe('Entre 1 y 4 preguntas para hacer al usuario en este turno.'),
})

// ── show_html Zod schema ──────────────────────────────────────────────────
// Contrato equivalente al part `html` del canal web (cerp-ai-service/lib/agents/parts.ts
// htmlPartSchema), portado al desktop como tool MCP en vez de UI part del stream de la
// SDK Vercel AI — acá el "part" lo emite htmlCanvasBridge, no un data-<parte> del stream.
const ShowHtmlSchema = z.object({
  title: z
    .string()
    .max(120)
    .optional()
    .describe('Encabezado corto de la tarjeta (ej: "Comparativa de presupuestos"). Si se omite, se usa "Lienzo".'),
  html: z
    .string()
    .min(1)
    .max(256_000)
    .describe(
      'Documento HTML completo o fragmento a dibujar (comparativa, esquema, tabla con formato, grafico con divs o SVG inline). ' +
        'Se renderiza AISLADO: sin acceso a la pagina ni a internet. TODO el CSS y JS va inline o en un <style>/<script> del propio documento — ' +
        'NO puede cargar imagenes, fuentes, scripts ni datos de ninguna URL externa (si funcionan imagenes data: y SVG inline). ' +
        'Maximo 256 KB.',
    ),
})

/**
 * Creates an in-process MCP server with all CERP tools.
 * companyId is injected automatically into write operations.
 */
export function createCerpMcpServer(httpClient: HttpClient, companyId: string | null, userId: string | null, conversationId = '__default__') {
  // ── attach_budget_pdf tool ────────────────────────────────────────────────
  // Reads a local PDF and uploads it to CERP via multipart. The PDF will appear
  // at the end of the printed cotización in both CERP IA and the ERP web app.
  const attachBudgetPdfTool = tool(
    'attach_budget_pdf',
    'Adjunta un PDF local como archivo adicional de un presupuesto CERP. El PDF aparecerá al final del PDF de cotización generado y también en la app web de CERP. Usar cuando el usuario quiere agregar un documento adicional (condiciones generales, plano, anexo) a una cotización.',
    AttachBudgetPdfSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = AttachBudgetPdfSchema.parse(args)
        const { readFileSync, existsSync } = require('fs') as typeof import('fs')
        const { basename } = require('path') as typeof import('path')

        if (!existsSync(parsed.filePath)) {
          throw new Error(`Archivo no encontrado: ${parsed.filePath}`)
        }

        const buffer = readFileSync(parsed.filePath)
        const filename = basename(parsed.filePath)

        const formData = new FormData()
        formData.append('file', new Blob([buffer], { type: 'application/pdf' }), filename)
        formData.append('budgetId', parsed.budgetId)
        if (parsed.description) formData.append('description', parsed.description)

        const result = await httpClient.uploadFile(
          `/projects/${parsed.projectId}/attachments/upload`,
          formData,
        )

        logger.info(`attach_budget_pdf OK: "${filename}" → project ${parsed.projectId} / budget ${parsed.budgetId}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`attach_budget_pdf FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // ── download_budget_attachment tool ───────────────────────────────────────
  // Downloads a PDF from GridFS and saves it locally so the report-generator
  // can concatenate it to the cotización PDF using Python.
  const downloadBudgetAttachmentTool = tool(
    'download_budget_attachment',
    'Descarga un archivo PDF adjunto de un presupuesto desde CERP y lo guarda localmente. Usar cuando necesitas el PDF físicamente en disco para concatenarlo al PDF de cotización.',
    DownloadBudgetAttachmentSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = DownloadBudgetAttachmentSchema.parse(args)

        await httpClient.downloadFile(
          `/projects/${parsed.projectId}/attachments/${parsed.attachmentId}/download`,
          parsed.savePath,
        )

        logger.info(`download_budget_attachment OK: attachment ${parsed.attachmentId} → ${parsed.savePath}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ savedTo: parsed.savePath }) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`download_budget_attachment FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // ── ask_user_question tool ────────────────────────────────────────────────
  // Suspends agent execution and shows a structured question widget in the UI.
  const askUserTool = tool(
    'ask_user_question',
    'Pide aclaraciones estructuradas al usuario con opciones predefinidas. ' +
      'Usar SOLO cuando se necesita una decision especifica (IVA, cliente, porcentaje, etc.) ' +
      'y hay opciones discretas claramente definidas. ' +
      'NO usar para preguntas abiertas — para eso, escribir texto libre en el chat. ' +
      'El sistema agrega automaticamente una opcion "Otro..." al final de cada pregunta.',
    AskUserQuestionSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = AskUserQuestionSchema.parse(args)
        const answers = await waitForAnswer(conversationId, { questions: parsed.questions })
        const answerText = Object.entries(answers)
          .map(([q, a]) => `${q}: ${Array.isArray(a) ? a.join(', ') : a}`)
          .join('\n')
        logger.info(`ask_user_question answered:\n${answerText}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(answers, null, 2) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`ask_user_question failed: ${message}`)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        }
      }
    },
    { annotations: { readOnlyHint: true } },
  )

  // ── show_html tool ────────────────────────────────────────────────────────
  // Emite un lienzo HTML visual (comparativa, esquema, tabla con formato, grafico
  // inline). No pega al backend de CERP: solo valida y avisa al renderer via el
  // bridge — el render seguro (sandbox de iframe + CSP interna) vive del lado
  // del renderer (HtmlCanvasCard.tsx), portado del mismo modelo de seguridad
  // que usa el canal web (cerp-ai-frontend/src/components/chat/parts/HtmlCanvasCard.tsx).
  const showHtmlTool = tool(
    'show_html',
    'Dibuja un lienzo visual escribiendo HTML: una comparativa, un esquema, una tabla con formato, un grafico hecho con divs o SVG inline. ' +
      'Se muestra aislado, sin acceso a la app ni a internet: todo el CSS y JS va inline o en un <style>/<script> del propio documento, y NO puede cargar imagenes, fuentes, scripts ni datos de ninguna URL externa (si funcionan imagenes data: y SVG inline). ' +
      'Usala cuando la forma visual aporte de verdad — para presupuestos usa las tools de budget, que ademas se exportan a PDF/Excel. ' +
      'Tu texto tiene que seguir explicando la respuesta: el lienzo ACOMPAÑA, no reemplaza.',
    ShowHtmlSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = ShowHtmlSchema.parse(args)
        const toolUseId = randomUUID()
        emitHtmlCanvasEvent(conversationId, {
          toolUseId,
          title: parsed.title?.trim() || 'Lienzo',
          html: parsed.html,
        })
        logger.info(`show_html OK: "${parsed.title || 'Lienzo'}" (${parsed.html.length} chars) → conversation ${conversationId}`)
        return { content: [{ type: 'text' as const, text: 'Lienzo mostrado al usuario.' }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`show_html FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )

  // ── CERP REST API tools ───────────────────────────────────────────────────
  const cerpApiTools = Object.entries(toolSchemas).map(([name, def]) =>
    tool(
      name,
      def.description,
      def.schema as any,
      async (args: Record<string, unknown>) => {
        try {
          // Carga masiva de tareas: chunking + reanudación, no pasa por buildRequest.
          if (name === 'create_tasks_batch') {
            const result = await runTasksBatch(
              args as unknown as { projectId: string; tasks: BatchTaskArg[] },
              httpClient,
              companyId,
              userId
            )
            const text = JSON.stringify(result, null, 2)
            logger.info(`MCP create_tasks_batch OK: ${text.substring(0, 200)}`)
            return { content: [{ type: 'text' as const, text }] }
          }

          const { url, body } = buildRequest(def.endpoint, def.method, args, def.fieldMap)
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

          // Cortafuegos: el heartbeat acompaña la vida de la reserva. Arranca al
          // reservar (extrae el quoteId de la respuesta) y se detiene al commitear
          // o refundar — el watchdog del backend cubre cualquier corte abrupto.
          if (name === 'quote_reserve') {
            const r = data as { quoteId?: string; source?: string; requiresAction?: boolean } | null
            if (r?.quoteId) {
              startQuoteHeartbeat(String(r.quoteId), httpClient)
              emitQuoteFirewallEvent({
                kind: 'reserved',
                quoteId: String(r.quoteId),
                source: String(r.source ?? ''),
                requiresAction: Boolean(r.requiresAction),
              })
            }
          } else if (name === 'quote_commit') {
            stopQuoteHeartbeat()
            const c = data as
              | { committed?: boolean; validation?: { message?: string; failures?: string[] } }
              | null
            const quoteId = String((args as { id?: string }).id ?? '')
            if (c?.committed) {
              emitQuoteFirewallEvent({ kind: 'committed', quoteId })
            } else {
              emitQuoteFirewallEvent({
                kind: 'rolled_back',
                quoteId,
                reason: 'post_flight_fail',
                message: c?.validation?.message ?? 'La cotización no superó la validación.',
                failures: c?.validation?.failures ?? [],
              })
            }
          } else if (name === 'quote_refund') {
            stopQuoteHeartbeat()
            emitQuoteFirewallEvent({
              kind: 'rolled_back',
              quoteId: String((args as { id?: string }).id ?? ''),
              reason: String((data as { refundReason?: string } | null)?.refundReason ?? 'user_aborted'),
              message: 'La cotización se canceló antes de finalizar.',
              failures: [],
            })
          }

          const text = JSON.stringify(data, null, 2)
          logger.info(`MCP ${name} OK: ${text.substring(0, 200)}`)
          return { content: [{ type: 'text' as const, text }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`MCP ${name} FAILED: ${message}`)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
        }
      },
      // Auto-annotate: GET tools are read-only → enables parallel execution
      { annotations: { readOnlyHint: def.method === 'GET', destructiveHint: def.method === 'DELETE' } },
    ),
  )

  return createSdkMcpServer({
    name: 'cerp',
    version: '2.0.0',
    tools: [askUserTool, attachBudgetPdfTool, downloadBudgetAttachmentTool, showHtmlTool, ...cerpApiTools],
  })
}

function buildRequest(
  endpoint: string,
  method: string,
  args: Record<string, unknown>,
  fieldMap?: Record<string, string>,
): { url: string; body?: Record<string, unknown> } {
  const remaining: Record<string, unknown> = {}
  let path = endpoint

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue

    const placeholder = `:${key}`
    if (path.includes(placeholder)) {
      path = path.replace(placeholder, String(value))
    } else {
      remaining[fieldMap?.[key] ?? key] = value
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
