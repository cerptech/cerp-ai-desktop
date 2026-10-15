import { useEffect, useState } from 'react'
import { useQuoteFirewall } from '@/hooks/useQuoteFirewall'
import { getToolHumanLabel } from '@/utils/toolUtils'

interface QuoteFirewallBannerProps {
  /** Conversación cuyo estado de carga se muestra. */
  conversationId: string
  /** El agente de esta conversación está trabajando (streaming o pendiente). */
  busy: boolean
  /** Tool que está corriendo ahora (para "Paso actual"). */
  activeTool?: string | null
  /** Reintento tras un corte del sistema (retoma la carga donde quedó). */
  onRetry?: () => void
  /** Reintento tras una validación fallida: completar sobre el mismo borrador. */
  onRetryData?: (failures: string[]) => void
}

function formatElapsed(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return 'menos de 1 min'
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

function CloseButton({ onClick, className }: { onClick: () => void; className: string }) {
  return (
    <button onClick={onClick} className={`${className} transition-colors shrink-0`} title="Cerrar" aria-label="Cerrar aviso">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  )
}

/**
 * Banner de estado de la carga de un presupuesto (cortafuegos de cotización, Idea 2),
 * por conversación. Garantiza que el usuario siempre vea en qué punto está la carga y
 * que termine en "listo" o "no se completó" — nunca en silencio (RQM-166):
 *  - in_progress: trabajando, con el tiempo transcurrido y el paso actual.
 *  - paused:      el turno terminó con la cotización abierta; CERP IA espera al usuario.
 *  - committed:   presupuesto listo; persiste hasta cerrarlo.
 *  - rolled_back: no se completó, sin cargo. Distingue datos / sistema / cancelación y
 *                 ofrece reintentar sin volver a adjuntar los archivos.
 *
 * Copy en registro formal (sin coloquialismos).
 */
export function QuoteFirewallBanner({ conversationId, busy, activeTool, onRetry, onRetryData }: QuoteFirewallBannerProps) {
  const { state, dismiss } = useQuoteFirewall(conversationId)
  const [, setTick] = useState(0)

  // Refresca el tiempo transcurrido mientras la carga está en curso.
  useEffect(() => {
    if (state.phase !== 'in_progress') return
    const t = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [state.phase])

  if (state.phase === 'idle') return null

  // Reserva abierta pero el agente no está trabajando (el turno terminó y el evento de
  // pausa todavía no llegó, o el renderer detectó que el main dejó de responder): no
  // puede decir "trabajando".
  const phase = state.phase === 'in_progress' && !busy ? 'paused' : state.phase

  if (phase === 'in_progress') {
    const elapsed = state.startedAt ? formatElapsed(Date.now() - state.startedAt) : null
    return (
      <div role="status" className="flex items-start gap-2 px-6 py-2 bg-sky-50 border-b border-sky-100 text-sky-800 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse mt-1 shrink-0" />
        <div className="flex-1 min-w-0">
          <p>
            <span className="font-medium">Cargando el presupuesto en CERP</span>
            {elapsed && <span className="text-sky-600"> · en curso desde hace {elapsed}</span>}
            {activeTool && <span className="text-sky-600"> · {getToolHumanLabel(activeTool)}</span>}
          </p>
          <p className="mt-0.5 text-sky-700">
            El crédito queda reservado y solo se aplica si la cotización se genera correctamente. Te avisamos al terminar.
          </p>
          {state.requiresAction && (
            <p className="mt-0.5 font-medium text-amber-700">
              Tu entidad bancaria requiere autenticación adicional para autorizar el pago.
            </p>
          )}
        </div>
      </div>
    )
  }

  if (phase === 'paused') {
    return (
      <div role="status" className="flex items-start gap-2 px-6 py-2 bg-slate-50 border-b border-slate-200 text-slate-700 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mt-1 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">Carga del presupuesto en pausa: CERP IA espera tu respuesta en la conversación para continuar.</p>
          <p className="mt-0.5 text-slate-500">
            El crédito sigue reservado y solo se aplica si la cotización se genera correctamente.
          </p>
        </div>
        {onRetry && !busy && (
          <button onClick={onRetry} className="shrink-0 font-medium text-slate-700 hover:text-brand-orange underline transition-colors">
            Continuar la carga
          </button>
        )}
      </div>
    )
  }

  if (phase === 'committed') {
    return (
      <div role="status" className="flex items-start gap-2 px-6 py-2 bg-emerald-50 border-b border-emerald-100 text-emerald-800 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">
            Presupuesto listo{state.projectName ? `: ${state.projectName}` : ''}.
          </p>
          <p className="mt-0.5 text-emerald-700">La cotización se generó correctamente y se aplicó el crédito correspondiente.</p>
        </div>
        {state.projectId && (
          <a
            href={`https://app.cerp.es/projects/${state.projectId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 font-medium text-emerald-700 hover:text-emerald-900 underline transition-colors"
          >
            Abrir en CERP
          </a>
        )}
        <CloseButton onClick={dismiss} className="text-emerald-500 hover:text-emerald-700" />
      </div>
    )
  }

  // rolled_back
  if (state.cause === 'user') {
    return (
      <div role="status" className="flex items-start gap-2 px-6 py-2 bg-slate-50 border-b border-slate-200 text-slate-700 text-xs shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mt-1 shrink-0" />
        <p className="flex-1 min-w-0">La cotización se canceló antes de finalizar. No se aplicó ningún cargo ni se consumió el crédito.</p>
        <CloseButton onClick={dismiss} className="text-slate-400 hover:text-slate-600" />
      </div>
    )
  }

  const isData = state.cause === 'data'
  const failures = state.failures ?? []
  return (
    <div role="alert" className="flex items-start gap-3 px-6 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          {isData
            ? 'Problema con los datos: el presupuesto no se pudo completar con la información disponible.'
            : 'Problema del sistema: la carga se detuvo por un fallo nuestro, no de tus datos.'}
        </p>
        {isData && state.message && <p className="mt-0.5 text-amber-800">{state.message}</p>}
        {isData && failures.length > 0 && (
          <ul className="mt-0.5 list-disc pl-4 text-amber-800">
            {failures.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        <p className="mt-0.5 text-amber-700">
          No se aplicó ningún cargo ni se consumió el crédito. Lo ya cargado quedó guardado como borrador en CERP.
        </p>
      </div>
      {isData && onRetryData && !busy && (
        <button onClick={() => onRetryData(failures)} className="shrink-0 font-medium text-amber-800 hover:text-amber-950 underline transition-colors">
          Completar y reintentar
        </button>
      )}
      {!isData && onRetry && !busy && (
        <button onClick={onRetry} className="shrink-0 font-medium text-amber-800 hover:text-amber-950 underline transition-colors">
          Reintentar
        </button>
      )}
      <CloseButton onClick={dismiss} className="text-amber-500 hover:text-amber-700" />
    </div>
  )
}
