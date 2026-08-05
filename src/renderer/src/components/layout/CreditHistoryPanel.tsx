import { useEffect, useState } from 'react'

/**
 * Historial de créditos (Modelo CERP) / cotizaciones (Idea 2, legacy).
 * Con el modo de créditos activo (`shadow`/`enforce`) muestra el extracto del
 * ledger de créditos (grants, consumo, reservas). Con `mode:'off'` o si ese fetch
 * falla, el panel se comporta EXACTAMENTE como antes: historial de cotizaciones.
 * Se abre desde el indicador del header (CreditBalanceBadge / QuoteStatusBadge).
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

type CreditLedgerEntryType =
  | 'grant_monthly'
  | 'grant_trial'
  | 'grant_topup'
  | 'grant_admin'
  | 'debit_usage'
  | 'reserve'
  | 'reserve_commit'
  | 'reserve_release'
  | 'adjustment'

interface CreditLedgerEntry {
  id: string
  type: CreditLedgerEntryType
  amountHundredths: number
  kind?: string
  shadow?: boolean
  createdAt: string
  note?: string
}

const LEDGER_TYPE_LABEL: Record<CreditLedgerEntryType, string> = {
  grant_monthly: 'Créditos del plan',
  grant_topup: 'Compra de créditos',
  grant_trial: 'Créditos de prueba',
  grant_admin: 'Ajuste de CERP',
  debit_usage: 'Consumo de IA',
  reserve: 'Reserva de cotización',
  reserve_commit: 'Reserva confirmada',
  reserve_release: 'Reserva liberada',
  adjustment: 'Ajuste',
}

function ledgerLabel(entry: CreditLedgerEntry): string {
  const base = LEDGER_TYPE_LABEL[entry.type] ?? entry.type
  return entry.type === 'debit_usage' && entry.kind ? `${base} (${entry.kind})` : base
}

/** Céntimas → créditos con signo y 1 decimal (ej. -320 → "-3.2", 5000 → "+50.0"). */
function formatLedgerAmount(hundredths: number): string {
  const value = hundredths / 100
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}`
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
  const [ledgerEntries, setLedgerEntries] = useState<CreditLedgerEntry[] | null>(null)
  // null = todavía no se determinó; 'off' cubre también "no se pudo consultar el balance".
  const [creditsMode, setCreditsMode] = useState<'off' | 'shadow' | 'enforce' | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      let mode: 'off' | 'shadow' | 'enforce' = 'off'
      try {
        const balance = await window.cerpAPI.getCreditsBalance()
        mode = balance?.mode ?? 'off'
      } catch {
        mode = 'off'
      }
      if (cancelled) return
      setCreditsMode(mode)

      if (mode !== 'off') {
        try {
          const ledger = await window.cerpAPI.getCreditsLedger(30)
          if (!cancelled) setLedgerEntries(ledger?.entries ?? [])
        } catch {
          if (!cancelled) setError(true)
        }
        return
      }

      // Fallback (mode 'off' o balance no disponible): panel de cotizaciones de siempre.
      window.cerpAPI
        .listQuotes(1, 30)
        .then((res) => {
          if (!cancelled) setRows((res?.items as unknown as QuoteRow[]) ?? [])
        })
        .catch(() => {
          if (!cancelled) setError(true)
        })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const usingLedger = creditsMode !== null && creditsMode !== 'off'
  const loading = creditsMode === null || (usingLedger ? ledgerEntries === null : rows === null)

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
          <h2 className="text-sm font-semibold text-slate-800">
            {usingLedger ? 'Historial de créditos' : 'Historial de cotizaciones'}
          </h2>
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
          {!error && loading && (
            <p className="text-xs text-slate-400 p-4 text-center">Cargando…</p>
          )}

          {!error && !loading && usingLedger && ledgerEntries?.length === 0 && (
            <p className="text-xs text-slate-500 p-4 text-center">Todavía no tenés movimientos de créditos.</p>
          )}
          {!error && usingLedger && ledgerEntries?.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md hover:bg-slate-50">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-800 truncate">{ledgerLabel(entry)}</p>
                <p className="text-[11px] text-slate-400">
                  {formatDate(entry.createdAt)}
                  {entry.note ? ` · ${entry.note}` : ''}
                  {entry.shadow ? ' · modo prueba' : ''}
                </p>
              </div>
              <span className={`shrink-0 text-xs font-semibold ${entry.amountHundredths > 0 ? 'text-emerald-600' : 'text-slate-500'}`}>
                {formatLedgerAmount(entry.amountHundredths)}
              </span>
            </div>
          ))}

          {!error && !loading && !usingLedger && rows?.length === 0 && (
            <p className="text-xs text-slate-500 p-4 text-center">Todavía no generaste cotizaciones.</p>
          )}
          {!error && !usingLedger && rows?.map((q) => {
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
