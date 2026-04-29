import { useEffect, useState } from 'react'

type Eligibility = {
  canQuote: boolean
  freeAvailable: boolean
  freeSource: 'trial_free' | 'monthly_free' | null
  priceCents: number
  currency: string
  paidThisMonth: number
  prepaidCredits: number
  blockedReason?: 'no_subscription' | 'subscription_inactive'
}

const REFRESH_INTERVAL_MS = 60_000

function pluralCotizaciones(n: number): string {
  return n === 1 ? '1 cotización gratis' : `${n} cotizaciones gratis`
}

export function QuoteStatusBadge() {
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await window.cerpAPI.getQuoteEligibility()
        if (!cancelled) {
          setEligibility(result)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = setInterval(load, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-slate-400 text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse" />
        Cotización…
      </div>
    )
  }

  if (!eligibility) return null

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
