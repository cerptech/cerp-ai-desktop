/**
 * quoteEventsBridge — emite eventos de estado del cortafuegos de cotización (Idea 2)
 * desde el main process hacia el renderer, para que la UI dibuje el progreso, el
 * banner de rollback, etc.
 *
 * Mismo patrón que askUserBridge: el agentManager registra la ventana activa y el
 * mcpServer dispara los eventos cuando se ejecutan las tools quote_reserve /
 * quote_commit / quote_refund. El agentManager además emite `paused` / `resumed`
 * cuando un turno termina o arranca con la reserva todavía abierta, y `rolled_back`
 * con causa 'system' cuando el turno se corta por un fallo nuestro (RQM-166: antes,
 * si el turno terminaba sin commit ni refund, el banner decía "Generando tu
 * cotización" para siempre).
 *
 * Cada evento lleva su `conversationId`: el banner muestra el estado de la
 * conversación que el usuario está mirando, no el de la última que reservó.
 */
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'

/** 'data' = el entregable no pasó la validación; 'system' = la ejecución se cortó por un fallo nuestro; 'user' = el usuario la canceló. */
export type QuoteFailureCause = 'data' | 'system' | 'user'

/** Evento de transición del cortafuegos (discriminado por `kind`). */
export type QuoteFirewallEvent =
  | { kind: 'reserved'; conversationId: string; quoteId: string; source: string; requiresAction: boolean }
  // El turno terminó bien pero la cotización sigue abierta (el agente espera al usuario).
  | { kind: 'paused'; conversationId: string; quoteId: string }
  // Arrancó un turno nuevo sobre una reserva abierta.
  | { kind: 'resumed'; conversationId: string; quoteId: string }
  | { kind: 'committed'; conversationId: string; quoteId: string; projectId?: string; projectName?: string; budgetId?: string }
  | { kind: 'rolled_back'; conversationId: string; quoteId: string; reason: string; message: string; failures: string[]; cause: QuoteFailureCause }

let mainWindowRef: BrowserWindow | null = null

export function setQuoteEventWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/** Envía un evento del cortafuegos al renderer (best-effort). */
export function emitQuoteFirewallEvent(event: QuoteFirewallEvent): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  logger.info(`Quote firewall event → renderer: ${event.kind} (${event.quoteId}, ${event.conversationId})`)
  mainWindowRef.webContents.send(IPC_CHANNELS.QUOTE_FIREWALL_EVENT, event)
}
