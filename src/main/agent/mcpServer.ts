import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toolSchemas } from './toolDefinitions'
import { HttpClient } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'

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
    AskUserQuestionSchema,
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

  // ── CERP REST API tools ───────────────────────────────────────────────────
  const cerpApiTools = Object.entries(toolSchemas).map(([name, def]) =>
    tool(
      name,
      def.description,
      def.schema,
      async (args: Record<string, unknown>) => {
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
    tools: [askUserTool, attachBudgetPdfTool, downloadBudgetAttachmentTool, ...cerpApiTools],
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
