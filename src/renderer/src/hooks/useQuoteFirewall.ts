import { useEffect, useRef, useState, useCallback } from 'react'
import type { QuoteFirewallEvent } from '../../../preload/index'

/**
 * Estado en vivo del cortafuegos de cotización (Idea 2), alimentado por los eventos
 * IPC que emite el main durante el flujo reserve → commit/refund.
 *
 *   in_progress → reserva activa, el agente está generando la cotización.
 *   committed   → la cotización se generó bien y el crédito se aplicó (auto-oculta).
 *   rolled_back → la cotización no superó la validación; NO se cobró. Persiste hasta
 *                 que el usuario lo cierra (necesita leer qué falló y reintentar).
 */
export type FirewallPhase = 'idle' | 'in_progress' | 'committed' | 'rolled_back'

export interface FirewallState {
  phase: FirewallPhase
  quoteId?: string
  message?: string
  failures?: string[]
  requiresAction?: boolean
}

const COMMITTED_AUTO_HIDE_MS = 6_000

export function useQuoteFirewall() {
  const [state, setState] = useState<FirewallState>({ phase: 'idle' })
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHideTimer = (): void => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }

  const dismiss = useCallback(() => {
    clearHideTimer()
    setState({ phase: 'idle' })
  }, [])

  useEffect(() => {
    const off = window.cerpAPI.onQuoteFirewallEvent((event: QuoteFirewallEvent) => {
      clearHideTimer()
      if (event.kind === 'reserved') {
        setState({ phase: 'in_progress', quoteId: event.quoteId, requiresAction: event.requiresAction })
      } else if (event.kind === 'committed') {
        setState({ phase: 'committed', quoteId: event.quoteId })
        hideTimer.current = setTimeout(() => setState({ phase: 'idle' }), COMMITTED_AUTO_HIDE_MS)
      } else if (event.kind === 'rolled_back') {
        setState({
          phase: 'rolled_back',
          quoteId: event.quoteId,
          message: event.message,
          failures: event.failures,
        })
      }
    })
    return () => {
      off()
      clearHideTimer()
    }
  }, [])

  return { state, dismiss }
}
