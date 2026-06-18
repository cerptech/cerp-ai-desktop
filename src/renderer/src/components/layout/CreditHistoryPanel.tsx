import { useEffect, useState } from 'react'

/**
 * Historial de uso de créditos de cotización (Idea 2).
 * Muestra las cotizaciones recientes con su resultado: cuáles consumieron crédito,
 * cuáles se devolvieron y por qué. Se abre desde el indicador de créditos del header.
 */

interface QuoteRow {
  _id: string
  source: string
  status: string
  lifecycle?: 'reserved' | 'committed' | 'refunded'
  refundReason?: string
  amountCents: number
  currency: string
  createdAt?: string
  metadata?: { projectName?: string }
}

const SOURCE_LABEL: Record<string, string> = {
  trial_free: 'Cotización gratis (prueba)',
  monthly_free: 'Cotización gratis (mensual)',
  paid_extra: 'Cotización paga',
  paid_credit: 'Crédito prepago',
  unlimited: 'Plan ilimitado',
}

const REFUND_REASON_LABEL: Record<string, string> = {
  post_flight_fail: 'La cotización no superó la validación',
  heartbeat_timeout: 'La generación se interrumpió',
  preflight_fail: 'Faltaban datos para generar',
  user_aborted: 'Cancelada por el usuario',
  error: 'Error durante la generación',
}

/** Estado de consumo legible para el usuario. */
function outcome(q: QuoteRow): { label: string; tone: string; detail?: string } {
  if (q.lifecycle === 'refunded') {
    return {
      label: 'Crédito no consumido',
      tone: 'text-amber-700 bg-amber-50',
      detail: q.refundReason ? REFUND_REASON_LABEL[q.refundReason] ?? q.refundReason : undefined,
    }
  }
  if (q.lifecycle === 'reserved') {
    return { label: 'En curso', tone: 'text-sky-700 bg-sky-50' }
  }
  // committed o quotes legacy (sin lifecycle) → consumida
  return { label: 'Crédito consumido', tone: 'text-emerald-700 bg-emerald-50' }
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

export function CreditHistoryPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<QuoteRow[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.cerpAPI
      .listQuotes(1, 30)
      .then((res) => {
        if (!cancelled) setRows((res?.items as unknown as QuoteRow[]) ?? [])
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800">Historial de cotizaciones</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Cerrar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-2">
          {error && (
            <p className="text-xs text-slate-500 p-4 text-center">No se pudo cargar el historial.</p>
          )}
          {!error && rows === null && (
            <p className="text-xs text-slate-400 p-4 text-center">Cargando…</p>
          )}
          {!error && rows?.length === 0 && (
            <p className="text-xs text-slate-500 p-4 text-center">Todavía no generaste cotizaciones.</p>
          )}
          {rows?.map((q) => {
            const o = outcome(q)
            return (
              <div key={q._id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md hover:bg-slate-50">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-800 truncate">
                    {q.metadata?.projectName || SOURCE_LABEL[q.source] || 'Cotización'}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {formatDate(q.createdAt)} · {SOURCE_LABEL[q.source] || q.source}
                    {o.detail ? ` · ${o.detail}` : ''}
                  </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-medium ${o.tone}`}>
                  {o.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
