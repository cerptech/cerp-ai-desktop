/**
 * htmlCanvasBridge — emite el evento `html_canvas` (tool `show_html`) desde el
 * main process hacia el renderer, y guarda el HTML de cada lienzo en memoria
 * para que el protocolo `cerp-canvas://` (ver `canvasProtocol.ts`) lo sirva con
 * su propia CSP por HEADER — no por meta tag dentro de un `srcDoc`.
 *
 * ── Por qué no `srcDoc` ──────────────────────────────────────────────────────
 * La primera versión de este lienzo usaba `<iframe srcDoc="...">` con una CSP
 * puesta en un `<meta http-equiv="Content-Security-Policy">` DENTRO del propio
 * documento. Verificado en runtime que eso no alcanza: un documento `srcdoc`
 * navega como `about:srcdoc`, que el spec de CSP trata como parte del mismo
 * "documento" que lo embebe para efectos de política — la CSP efectiva es la
 * INTERSECCIÓN entre la del renderer (`src/renderer/index.html`, que tiene
 * `script-src 'self'` SIN `unsafe-inline`) y la del meta tag del lienzo. Esa
 * intersección mata `script-src 'unsafe-inline'`: ningún `<script>` inline del
 * lienzo corre — ni las gráficas que arma el agente ni el HEIGHT_REPORTER que
 * mide el alto —, y el iframe queda clavado en la altura por defecto (240px).
 *
 * La solución (sin tocar la CSP del renderer, que protege TODO lo demás): el
 * lienzo se sirve desde un origen de verdad distinto, `cerp-canvas://<id>`,
 * cuya respuesta lleva la CSP como header HTTP real — eso ya NO se intersecta
 * con la del documento padre, porque no es un documento `about:srcdoc`
 * embebido sino una navegación a otro origen. El registro del scheme y el
 * `protocol.handle` viven en `canvasProtocol.ts`; acá solo se guarda el HTML
 * (`registerCanvas`/`getCanvasHtml`) y se coordina con la ventana activa.
 *
 * Mismo patrón que askUserBridge/quoteEventsBridge para el resto: agentManager
 * registra la ventana activa (runAgent) y mcpServer dispara el evento cuando
 * se ejecuta la tool `show_html`. Se reutiliza el canal AGENT_STREAM_MESSAGE
 * (en vez de uno dedicado) para que el evento fluya por el mismo pipeline que
 * el resto de los eventos de streaming.
 *
 * El contenido HTML completo (hasta 64 KB, ver ShowHtmlSchema en mcpServer.ts)
 * viaja en el evento en vez de por el mapeo genérico de tool_start/tool_done
 * (agentManager.ts `extractInputStr` / `extractToolResultOutput`) porque esas
 * funciones truncan a 200/800 caracteres — pensadas para logs legibles, no
 * para el payload real que hay que renderizar.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import type { AgentStreamEvent } from '../ipc/types'
import { logger } from '../utils/logger'

let mainWindowRef: BrowserWindow | null = null

export function setHtmlCanvasWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/**
 * Envía el lienzo HTML al renderer (best-effort). Devuelve `false` si no hay
 * ventana activa (o está destruida) — la tool `show_html` usa esto para
 * responderle `isError` al modelo en vez de dejarlo creer que el usuario vio
 * algo que en realidad nunca se mandó.
 */
export function emitHtmlCanvasEvent(
  conversationId: string,
  payload: { toolUseId: string; title: string; html: string },
): boolean {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return false
  const event: AgentStreamEvent = { type: 'html_canvas', ...payload }
  // JSON.stringify (no interpolación cruda): `title` lo escribe el modelo — sin
  // esto podía forjar saltos de línea/contenido falso en los logs.
  logger.info(`html_canvas → renderer (${conversationId}): ${JSON.stringify(payload.title)} (${payload.html.length} chars)`)
  mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, { conversationId, event })
  return true
}

// ── Store de canvases servidos por cerp-canvas:// ────────────────────────────
// El renderer registra el HTML (tool call en vivo O conversación restaurada de
// la DB, que no trae ningún id vivo de una sesión anterior) vía el canal IPC
// `canvas:register` y recibe un id de vuelta; el iframe navega a
// `cerp-canvas://<id>` y el protocolo (canvasProtocol.ts) lee este Map.
//
// Vive solo en memoria del proceso main — se reinicia con la app, así que un id
// de una sesión anterior nunca es válido y HtmlCanvasCard siempre re-registra
// al montar (no depende de que el id "sobreviva").

/** Tope de HTML aceptado al registrar — generoso frente al límite de la tool
 *  (64 KB, ver ShowHtmlSchema) para no rechazar lienzos de conversaciones
 *  persistidas antes de ese ajuste (llegaron a pedir hasta 256 KB). */
export const MAX_REGISTER_HTML_BYTES = 300_000

/** Tope de entradas vivas — evita una fuga de memoria en una sesión larga con
 *  muchos lienzos. Eviction FIFO simple (Map preserva orden de inserción). */
const MAX_CANVAS_ENTRIES = 200

const canvases = new Map<string, string>()

/** Registra un HTML y devuelve su id (`crypto.randomUUID`). `null` si excede el tope. */
export function registerCanvas(html: string): string | null {
  if (Buffer.byteLength(html, 'utf-8') > MAX_REGISTER_HTML_BYTES) {
    logger.warn(`canvas:register rechazado — HTML supera ${MAX_REGISTER_HTML_BYTES} bytes (${html.length} chars)`)
    return null
  }
  if (canvases.size >= MAX_CANVAS_ENTRIES) {
    const oldest = canvases.keys().next().value
    if (oldest !== undefined) canvases.delete(oldest)
  }
  const id = randomUUID()
  canvases.set(id, html)
  return id
}

export function getCanvasHtml(id: string): string | undefined {
  return canvases.get(id)
}

/** Limpia todos los canvases registrados — logout / reset global (agentManager.closeAllSessions). */
export function clearCanvases(): void {
  canvases.clear()
}
