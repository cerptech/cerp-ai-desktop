/**
 * htmlCanvasBridge — emite el evento `html_canvas` (tool `show_html`) desde el
 * main process hacia el renderer, para que la UI dibuje el lienzo HTML dentro
 * del mensaje del asistente en curso.
 *
 * Mismo patrón que askUserBridge/quoteEventsBridge: agentManager registra la
 * ventana activa (runAgent) y mcpServer dispara el evento cuando se ejecuta la
 * tool `show_html`. Se reutiliza el canal AGENT_STREAM_MESSAGE (en vez de uno
 * dedicado) para que el evento fluya por el mismo pipeline que el resto de los
 * eventos de streaming — agentRuntimeStore ya sabe rutear por conversationId y
 * acumular sobre el mensaje del asistente en curso sin plomería adicional.
 *
 * El contenido HTML completo (hasta 256 KB) viaja acá en vez de por el mapeo
 * genérico de tool_start/tool_done (agentManager.ts `extractInputStr` /
 * `extractToolResultOutput`) porque esas funciones truncan a 200/800
 * caracteres — pensadas para logs legibles, no para el payload real que hay
 * que renderizar.
 */
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import type { AgentStreamEvent } from '../ipc/types'
import { logger } from '../utils/logger'

let mainWindowRef: BrowserWindow | null = null

export function setHtmlCanvasWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/** Envía el lienzo HTML al renderer (best-effort; no bloquea la tool). */
export function emitHtmlCanvasEvent(
  conversationId: string,
  payload: { toolUseId: string; title: string; html: string },
): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  const event: AgentStreamEvent = { type: 'html_canvas', ...payload }
  logger.info(`html_canvas → renderer (${conversationId}): "${payload.title}" (${payload.html.length} chars)`)
  mainWindowRef.webContents.send(IPC_CHANNELS.AGENT_STREAM_MESSAGE, { conversationId, event })
}
