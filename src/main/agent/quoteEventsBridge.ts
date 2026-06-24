/**
 * quoteEventsBridge — emite eventos de estado del cortafuegos de cotización (Idea 2)
 * desde el main process hacia el renderer, para que la UI dibuje el progreso, el
 * banner de rollback, etc.
 *
 * Mismo patrón que askUserBridge: el agentManager registra la ventana activa y el
 * mcpServer dispara los eventos cuando se ejecutan las tools quote_reserve /
 * quote_commit / quote_refund.
 */
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { logger } from '../utils/logger'

/** Evento de transición del cortafuegos (discriminado por `kind`). */
export type QuoteFirewallEvent =
  | { kind: 'reserved'; quoteId: string; source: string; requiresAction: boolean }
  | { kind: 'committed'; quoteId: string }
  | { kind: 'rolled_back'; quoteId: string; reason: string; message: string; failures: string[] }

let mainWindowRef: BrowserWindow | null = null

export function setQuoteEventWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/** Envía un evento del cortafuegos al renderer (best-effort). */
export function emitQuoteFirewallEvent(event: QuoteFirewallEvent): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  logger.info(`Quote firewall event → renderer: ${event.kind} (${event.quoteId})`)
  mainWindowRef.webContents.send(IPC_CHANNELS.QUOTE_FIREWALL_EVENT, event)
}
