import { useQuoteFirewall } from '@/hooks/useQuoteFirewall'

/**
 * Banner de estado del cortafuegos de cotización (Idea 2).
 * Se muestra debajo del header durante el flujo de cotización:
 *  - in_progress: la reserva está activa (el crédito aún no se aplicó).
 *  - committed:   éxito (auto-oculta a los pocos segundos).
 *  - rolled_back: la cotización no superó la validación; no hubo cargo. Persiste
 *                 con el motivo y la guía de reintento hasta que el usuario lo cierra.
 *
 * Copy en registro formal (sin coloquialismos).
 */
export function QuoteFirewallBanner() {
  const { state, dismiss } = useQuoteFirewall()

  if (state.phase === 'idle') return null

  if (state.phase === 'in_progress') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-sky-50 border-b border-sky-100 text-sky-800 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
        <span>
          Generando tu cotización. El crédito quedó reservado y se aplicará únicamente si la cotización
          se genera correctamente.
        </span>
        {state.requiresAction && (
          <span className="ml-1 font-medium text-amber-700">
            Tu entidad bancaria requiere autenticación adicional para autorizar el pago.
          </span>
        )}
      </div>
    )
  }

  if (state.phase === 'committed') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-emerald-50 border-b border-emerald-100 text-emerald-800 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span>Cotización generada correctamente. Se aplicó el crédito correspondiente.</span>
      </div>
    )
  }

  // rolled_back
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">No se aplicó ningún cargo ni se consumió el crédito.</p>
        {state.message && <p className="mt-0.5 text-amber-800">{state.message}</p>}
        <p className="mt-0.5 text-amber-700">
          Podés revisar los datos y volver a intentarlo cuando quieras.
        </p>
      </div>
      <button
        onClick={dismiss}
        className="text-amber-500 hover:text-amber-700 transition-colors shrink-0"
        title="Cerrar"
        aria-label="Cerrar aviso"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
