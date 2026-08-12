import { useCallback, useEffect, useState } from 'react'
import type { ApiErrorCode } from '../../../../preload/index'

type Eligibility = {
  canQuote: boolean
  freeAvailable: boolean
  freeSource: 'trial_free' | 'monthly_free' | null
  priceCents: number
  currency: string
  paidThisMonth: number
  prepaidCredits: number
  unlimited: boolean
  blockedReason?: 'no_subscription' | 'subscription_inactive'
}

const REFRESH_INTERVAL_MS = 60_000

function pluralCotizaciones(n: number): string {
  return n === 1 ? '1 cotización gratis' : `${n} cotizaciones gratis`
}

export function QuoteStatusBadge() {
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const [loading, setLoading] = useState(true)
  // 'network' → badge de error con reintento (antes esto no mostraba nada).
  // 'auth' → el modal global de sesión expirada ya cubre el aviso.
  const [error, setError] = useState<ApiErrorCode | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await window.cerpAPI.getQuoteEligibility()
      if (result && 'error' in result) {
        setEligibility(null)
        setError(result.error)
      } else {
        setEligibility(result)
        setError(null)
      }
    } catch {
      setEligibility(null)
      setError('network')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await load()
    }
    run()
    const interval = setInterval(run, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-slate-400 text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse" />
        Cotización…
      </div>
    )
  }

  if (error === 'network') {
    return (
      <button
        onClick={load}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 text-red-700 hover:bg-red-100 text-xs transition-colors"
        title="No se pudo consultar el estado de cotizaciones. Click para reintentar."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Error · Reintentar
      </button>
    )
  }

  // error === 'auth' (modal global ya visible) o sin datos todavía.
  if (!eligibility) return null

  if (eligibility.unlimited) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-50 text-violet-700 text-xs"
        title="Tu empresa tiene CERP IA Ilimitado — generacion de cotizaciones sin limite"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
        Ilimitado
      </div>
    )
  }

  if (eligibility.blockedReason) {
    return (
      <a
        href="https://app.cerp.es/billing"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 text-xs hover:bg-amber-100 transition-colors"
        title="Tu plan no está activo. Click para gestionar."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Activá tu plan
      </a>
    )
  }

  const hasFree = eligibility.freeAvailable
  const credits = eligibility.prepaidCredits

  if (hasFree || credits > 0) {
    const parts: string[] = []
    if (hasFree) parts.push('1 gratis')
    if (credits > 0) parts.push(credits === 1 ? '1 disponible' : `${credits} disponibles`)
    const label = parts.join(' + ')
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs"
        title={hasFree && credits > 0 ? 'Tenés la cotización gratis del mes y créditos comprados disponibles' : hasFree ? 'Tenés tu cotización gratis del mes' : 'Cotizaciones compradas disponibles'}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        {label}
      </div>
    )
  }

  return (
    <a
      href="https://app.cerp.es/settings/subscription"
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 text-xs transition-colors"
      title="Comprar cotizaciones desde el SaaS"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Comprar
    </a>
  )
}
