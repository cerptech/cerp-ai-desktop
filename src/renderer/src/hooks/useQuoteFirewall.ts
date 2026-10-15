import { useSyncExternalStore } from 'react'
import type { QuoteFailureCause, QuoteFirewallEvent } from '../../../preload/index'

/**
 * Estado en vivo del cortafuegos de cotización (Idea 2), alimentado por los eventos
 * IPC que emite el main durante el flujo reserve → commit/refund. POR CONVERSACIÓN
 * (RQM-166): antes era un único estado global, así que la carga de una conversación de
 * fondo pisaba el banner de la que se estaba mirando.
 *
 *   in_progress → reserva activa y el agente trabajando en la cotización.
 *   paused      → el turno terminó con la reserva abierta: el agente espera al usuario.
 *                 Antes este caso no existía y el banner decía "Generando tu
 *                 cotización" para siempre.
 *   committed   → la cotización se generó bien: persiste hasta que el usuario lo cierra
 *                 (la confirmación de "presupuesto listo" no puede perderse si el
 *                 usuario no estaba mirando).
 *   rolled_back → no se completó; NO se cobró. `cause` distingue datos / sistema /
 *                 cancelación. Persiste hasta que el usuario lo cierra o reintenta.
 */
export type FirewallPhase = 'idle' | 'in_progress' | 'paused' | 'committed' | 'rolled_back'

export interface FirewallState {
  phase: FirewallPhase
  quoteId?: string
  /** Cuándo arrancó la cotización (reserva) — para mostrar el tiempo transcurrido. */
  startedAt?: number
  message?: string
  failures?: string[]
  cause?: QuoteFailureCause
  requiresAction?: boolean
  projectId?: string
  projectName?: string
  budgetId?: string
}

const IDLE: FirewallState = Object.freeze({ phase: 'idle' })

const states = new Map<string, FirewallState>()
const listeners = new Set<() => void>()
let wired = false

function set(conversationId: string, next: FirewallState): void {
  states.set(conversationId, next)
  for (const cb of listeners) cb()
}

function apply(event: QuoteFirewallEvent): void {
  const id = event.conversationId || '__default__'
  const prev = states.get(id) ?? IDLE
  switch (event.kind) {
    case 'reserved':
      set(id, { phase: 'in_progress', quoteId: event.quoteId, startedAt: Date.now(), requiresAction: event.requiresAction })
      break
    case 'resumed':
      set(id, { ...prev, phase: 'in_progress', quoteId: event.quoteId, startedAt: prev.startedAt ?? Date.now() })
      break
    case 'paused':
      // Un paused tardío no pisa un desenlace que ya llegó.
      if (prev.phase === 'committed' || prev.phase === 'rolled_back') break
      set(id, { ...prev, phase: 'paused', quoteId: event.quoteId })
      break
    case 'committed':
      set(id, { phase: 'committed', quoteId: event.quoteId, projectId: event.projectId, projectName: event.projectName, budgetId: event.budgetId })
      break
    case 'rolled_back':
      set(id, { phase: 'rolled_back', quoteId: event.quoteId, message: event.message, failures: event.failures, cause: event.cause })
      break
  }
}

/** Se suscribe UNA vez al IPC (idempotente) para no perder eventos de conversaciones de fondo. */
export function ensureQuoteFirewallWired(): void {
  if (wired) return
  wired = true
  window.cerpAPI.onQuoteFirewallEvent(apply)
}

export function dismissQuoteFirewall(conversationId: string): void {
  if ((states.get(conversationId) ?? IDLE).phase === 'idle') return
  set(conversationId, IDLE)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useQuoteFirewall(conversationId: string): { state: FirewallState; dismiss: () => void } {
  ensureQuoteFirewallWired()
  const state = useSyncExternalStore(subscribe, () => states.get(conversationId) ?? IDLE)
  return { state, dismiss: () => dismissQuoteFirewall(conversationId) }
}
