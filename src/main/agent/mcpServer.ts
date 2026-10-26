import { createHash, randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toolSchemas, clampLimitArgs } from './toolDefinitions'
import { createItemBankTools } from './itemBankTools'
import { createCatalogTools } from './catalogTools'
import { createCreditsTools } from './creditsTools'
import { createDocumentIntakeTools } from './documentIntakeTools'
import { createScheduleTools } from './scheduleTools'
import { createAppTools } from './appTools'
import { createProjectDocumentTools } from './projectDocumentTools'
import { createBudgetImportTools } from './budgetImportTools'
import { HttpClient, CompanyChangedError, NoActiveCompanyError, SessionRevokedError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'
import { normalizeQuestions } from './askUserQuestions'
import { startQuoteHeartbeat, stopQuoteHeartbeat } from './quoteHeartbeat'
import { emitQuoteFirewallEvent } from './quoteEventsBridge'
import { getLoadContext, rememberLoadContext } from './loadContext'
import { notifyUser } from './desktopNotifier'
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
      // Multi-empresa (plan DK-1.1): la empresa cambió, no hay empresa o la sesión se
      // revocó. Reanudar el lote NO sirve (y con la empresa nueva escribiría en otra
      // casa): el mensaje del error ya le dice al modelo que no reintente.
      if (err instanceof CompanyChangedError || err instanceof NoActiveCompanyError || err instanceof SessionRevokedError) {
        return { summary, results, error: message }
      }
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
// Tolerante a propósito (ver askUserQuestions.ts): una pregunta que no pasa la
// validación no se muestra, y el agente quedaba anunciando un widget que el usuario
// nunca veía. Las descripciones dicen lo IDEAL; los límites duros solo rechazan lo
// que el widget no puede dibujar (sin pregunta, sin opciones, o una lista absurda).

const AskUserQuestionOptionSchema = z.object({
  label: z.string().min(1).describe('Texto corto de la opcion que ve el usuario (1-5 palabras).'),
  description: z.string().optional().describe('Explicacion adicional de la opcion.'),
})

const AskUserQuestionItemSchema = z.object({
  question: z.string().min(1).describe('La pregunta completa terminando en signo de interrogacion.'),
  header: z.string().optional().describe('Etiqueta corta tipo chip, idealmente de hasta 12 caracteres. Ej: "IVA", "Cliente".'),
  multiSelect: z.boolean().optional().describe('true si el usuario puede elegir varias opciones (por defecto false).'),
  options: z
    .array(AskUserQuestionOptionSchema)
    .min(1)
    .max(8)
    .describe('Idealmente entre 2 y 4 opciones. El sistema agrega "Otro..." automaticamente.'),
})

const AskUserQuestionSchema = z.object({
  questions: z
    .array(AskUserQuestionItemSchema)
    .min(1)
    .max(8)
    .describe('Idealmente entre 1 y 4 preguntas para hacer al usuario en este turno.'),
})

/** Resumen legible de un error de validación de Zod, para que el modelo sepa qué corregir. */
function describeValidationError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

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
    .max(64_000)
    .describe(
      'Documento HTML completo o fragmento a dibujar (comparativa, esquema, tabla con formato, grafico con divs o SVG inline). ' +
        'Se renderiza AISLADO: sin acceso a la pagina ni a internet. TODO el CSS y JS va inline o en un <style>/<script> del propio documento — ' +
        'NO puede cargar imagenes, fuentes, scripts ni datos de ninguna URL externa (sí funcionan imagenes data: y SVG inline). ' +
        'Maximo 64 KB.',
    ),
})

/**
 * Creates an in-process MCP server with all CERP tools.
 * companyId is injected automatically into the REST proxy tools (`toolSchemas`,
 * see cerpApiTools below). The `schedule_*` tools (scheduleTools.ts) are built
 * apart and never go through that injection: /api/ai-tools only takes `{ input }`
 * and the company comes from the JWT (ADR 007).
 */
export function createCerpMcpServer(httpClient: HttpClient, companyId: string | null, userId: string | null, conversationId = '__default__') {
  // ── attach_budget_pdf tool ────────────────────────────────────────────────
  // Reads a local PDF and uploads it to CERP via multipart. The PDF will appear
  // at the end of the printed cotización in both CERP IA and the ERP web app.
  // F2.1: SOLO para el PDF que se anexa a la cotización. Guardar un documento en
  // el proyecto (plano, pliego, contrato) es save_project_document
  // (projectDocumentTools.ts), que sube sin budgetId.
  const attachBudgetPdfTool = tool(
    'attach_budget_pdf',
    'Adjunta un PDF local como archivo adicional de un presupuesto CERP: se anexa al final del PDF de cotizacion que recibe el cliente y tambien se ve en la app web de CERP. ' +
      'Usar SOLO cuando el usuario quiere que el PDF vaya dentro de la cotizacion (condiciones generales, anexo, plano para el cliente). ' +
      'Para guardar un documento en el proyecto (plano, pliego, memoria, contrato, foto) usa save_project_document. Solo acepta archivos .pdf.',
    AttachBudgetPdfSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = AttachBudgetPdfSchema.parse(args)
        const { readFileSync, existsSync } = require('fs') as typeof import('fs')
        const { basename } = require('path') as typeof import('path')

        if (!existsSync(parsed.filePath)) {
          throw new Error(`Archivo no encontrado: ${parsed.filePath}`)
        }
        // Se sube como application/pdf y se concatena a la cotización: otro tipo
        // rompería el PDF final. Para otros archivos, save_project_document.
        if (!/\.pdf$/i.test(parsed.filePath)) {
          throw new Error(`attach_budget_pdf solo adjunta PDF a un presupuesto. Para guardar este archivo en el proyecto usa save_project_document: ${parsed.filePath}`)
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
  // Es la ÚNICA vía de preguntas en Desktop (la `AskUserQuestion` nativa del SDK está
  // deshabilitada en agentManager). Si no se puede mostrar, el error le dice al modelo
  // que pregunte en texto — nunca debe dar por mostrado un widget que no apareció.
  const askUserTool = tool(
    'ask_user_question',
    'Pide aclaraciones estructuradas al usuario con opciones predefinidas: es la UNICA forma de mostrarle preguntas con opciones en CERP IA Desktop. ' +
      'Usar cuando se necesita una decision especifica (IVA, cliente, porcentaje, etc.) ' +
      'y hay opciones discretas claramente definidas. ' +
      'NO usar para preguntas abiertas — para eso, escribir texto libre en el chat. ' +
      'El sistema agrega automaticamente una opcion "Otro..." al final de cada pregunta. ' +
      'Si esta tool devuelve error, el usuario NO vio las preguntas: hacelas en texto.',
    AskUserQuestionSchema as any,
    async (args: Record<string, unknown>) => {
      let questions
      try {
        questions = normalizeQuestions(AskUserQuestionSchema.parse(args).questions)
      } catch (err) {
        const detail = describeValidationError(err)
        logger.error(`ask_user_question: formato inválido — ${detail}`)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Las preguntas no tienen un formato que el selector pueda mostrar (${detail}). El usuario NO las vio. Corregilas y volvé a llamar a ask_user_question, o hacelas en texto.`,
            }),
          }],
          isError: true,
        }
      }
      try {
        const answers = await waitForAnswer(conversationId, { questions })
        const answerText = Object.entries(answers)
          .map(([q, a]) => `${q}: ${Array.isArray(a) ? a.join(', ') : a}`)
          .join('\n')
        logger.info(`ask_user_question answered:\n${answerText}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(answers, null, 2) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`ask_user_question failed: ${message}`)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `No se pudo mostrar la pregunta al usuario (${message}). El usuario NO la vio: no digas que le mostraste opciones; hacé la pregunta en texto.`,
            }),
          }],
          isError: true,
        }
      }
    },
    // NO readOnly: las tools read-only pueden correr en paralelo, y dos preguntas a la
    // vez competían por el mismo widget (la primera volvía al agente como error).
    { annotations: { readOnlyHint: false } },
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
      'Se muestra aislado, sin acceso a la app ni a internet: todo el CSS y JS va inline o en un <style>/<script> del propio documento, y NO puede cargar imagenes, fuentes, scripts ni datos de ninguna URL externa (sí funcionan imagenes data: y SVG inline). ' +
      'Usala cuando la forma visual aporte de verdad — para presupuestos usa las tools de budget, que ademas se exportan a PDF/Excel. ' +
      'Tu texto tiene que seguir explicando la respuesta: el lienzo ACOMPAÑA, no reemplaza.',
    ShowHtmlSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = ShowHtmlSchema.parse(args)
        const toolUseId = randomUUID()
        const title = parsed.title?.trim() || 'Lienzo'
        const sent = emitHtmlCanvasEvent(conversationId, { toolUseId, title, html: parsed.html })
        if (!sent) {
          // Sin ventana activa (o destruida) el evento nunca llegó al renderer — el
          // modelo NO puede narrar "te muestro el lienzo" como si el usuario lo
          // hubiera visto, así que esto es un error de tool, no un éxito silencioso.
          logger.error(`show_html FAILED: no hay ventana activa para mostrar el lienzo (conversation ${conversationId})`)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No se pudo mostrar el lienzo: no hay ventana activa.' }) }],
            isError: true,
          }
        }
        logger.info(`show_html OK: ${JSON.stringify(title)} (${parsed.html.length} chars) → conversation ${conversationId}`)
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

          // QA del caso "proceso que no responde" (RQM-166): con CERP_DEBUG_HANG_TOOL=<tool>
          // esa tool nunca vuelve, como una llamada colgada. Junto con CERP_TURN_TIMEOUT_MS
          // bajo permite ver saltar el watchdog sin esperar 15 min. Solo por env (.env del
          // dev o junto al ejecutable): ningún cliente lo tiene.
          if (process.env.CERP_DEBUG_HANG_TOOL && process.env.CERP_DEBUG_HANG_TOOL === name) {
            logger.warn(`CERP_DEBUG_HANG_TOOL: ${name} queda colgada a propósito (QA del watchdog)`)
            await new Promise<never>(() => { /* nunca resuelve */ })
          }

          // `transformArgs` reforma los args cuando la diferencia con el API no es un
          // simple renombre (ids planos -> array de subdocumentos, campo plano ->
          // subdocumento anidado). Corre ANTES de buildRequest para que el resultado
          // pase por el mismo armado de URL y fieldMap que el resto.
          // Los limites de paginacion se recortan aca (el schema ya no los rechaza).
          const safeArgs = clampLimitArgs(def.schema, args)
          const apiArgs = def.transformArgs ? def.transformArgs(safeArgs) : safeArgs
          const { url, body } = buildRequest(def.endpoint, def.method, apiArgs, def.fieldMap)
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

          // Proyecto/presupuesto de la carga en curso (reintento y aviso de "listo").
          rememberLoadContext(conversationId, name, args, data)

          // Cortafuegos: el heartbeat acompaña la vida de la reserva. Arranca al
          // reservar (extrae el quoteId de la respuesta) y se detiene al commitear
          // o refundar — el watchdog del backend cubre cualquier corte abrupto.
          if (name === 'quote_reserve') {
            const r = data as { quoteId?: string; source?: string; requiresAction?: boolean } | null
            if (r?.quoteId) {
              startQuoteHeartbeat(conversationId, String(r.quoteId), httpClient)
              emitQuoteFirewallEvent({
                kind: 'reserved',
                conversationId,
                quoteId: String(r.quoteId),
                source: String(r.source ?? ''),
                requiresAction: Boolean(r.requiresAction),
              })
            }
          } else if (name === 'quote_commit') {
            stopQuoteHeartbeat(conversationId)
            const c = data as
              | { committed?: boolean; validation?: { message?: string; failures?: string[] } }
              | null
            const quoteId = String((args as { id?: string }).id ?? '')
            if (c?.committed) {
              const ctx = getLoadContext(conversationId)
              emitQuoteFirewallEvent({
                kind: 'committed',
                conversationId,
                quoteId,
                projectId: ctx?.projectId,
                projectName: ctx?.projectName,
                budgetId: String((args as { budgetId?: string }).budgetId ?? ctx?.budgetId ?? '') || undefined,
              })
              notifyUser('Presupuesto listo', ctx?.projectName ? `La carga de «${ctx.projectName}» terminó correctamente.` : 'La carga del presupuesto terminó correctamente.')
            } else {
              const message = c?.validation?.message ?? 'La cotización no superó la validación.'
              emitQuoteFirewallEvent({
                kind: 'rolled_back',
                conversationId,
                quoteId,
                reason: 'post_flight_fail',
                message,
                failures: c?.validation?.failures ?? [],
                cause: 'data',
              })
              notifyUser('La carga no se completó', message)
            }
          } else if (name === 'quote_refund') {
            stopQuoteHeartbeat(conversationId)
            const reason = String((data as { refundReason?: string } | null)?.refundReason ?? (args as { reason?: string }).reason ?? 'user_aborted')
            emitQuoteFirewallEvent({
              kind: 'rolled_back',
              conversationId,
              quoteId: String((args as { id?: string }).id ?? ''),
              reason,
              message:
                reason === 'preflight_fail'
                  ? 'Faltan datos para generar la cotización. CERP IA te indica en el chat qué necesita.'
                  : reason === 'error'
                    ? 'La cotización se detuvo por un error del sistema antes de finalizar.'
                    : 'La cotización se canceló antes de finalizar.',
              failures: [],
              cause: reason === 'preflight_fail' ? 'data' : reason === 'error' ? 'system' : 'user',
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
    tools: [
      askUserTool,
      attachBudgetPdfTool,
      downloadBudgetAttachmentTool,
      showHtmlTool,
      ...createCatalogTools(httpClient),
      ...createItemBankTools(httpClient),
      ...createCreditsTools(httpClient),
      ...createDocumentIntakeTools(httpClient),
      ...cerpApiTools,
      // Cronograma: POST /ai-tools/:name sin companyId; schedule_apply_change,
      // schedule_update_annotation y schedule_set_settings piden confirmación al
      // usuario en esta conversación antes de escribir.
      ...createScheduleTools(httpClient, conversationId),
      // Apps conectadas (Composio): POST /ai-tools/:name sin companyId, igual que el cronograma;
      // run_app_tool pide confirmación al usuario en esta conversación antes de escribir.
      ...createAppTools(httpClient, conversationId),
      // Documentos de proyecto (F2.1), AL FINAL (ADR 009: el orden de tools es parte
      // del prefijo cacheable): listar y leer por POST /ai-tools/:name sin companyId;
      // guardar sube el archivo local por la ruta REST de Documentos, sin budgetId,
      // y pide "Guardar" al usuario en esta conversación antes de subir.
      ...createProjectDocumentTools(httpClient, conversationId),
      // Importar un presupuesto tal cual (RQM-150): POST /budgets/:id/import-rows con las
      // filas del archivo; vista previa por defecto.
      ...createBudgetImportTools(httpClient, conversationId),
    ],
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
