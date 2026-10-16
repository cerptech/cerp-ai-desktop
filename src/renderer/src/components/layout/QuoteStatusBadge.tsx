import { useCallback, useEffect, useState } from 'react'
import type { ApiErrorCode } from '../../../../preload/index'
import { CreditsPill } from './CreditsPill'

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
    return <CreditsPill label="Cotización…" tone="loading" action={null} />
  }

  if (error === 'network') {
    return (
      <CreditsPill
        label="Error · Reintentar"
        tone="danger"
        onClick={load}
        title="No se pudo consultar el estado de cotizaciones. Haz clic para reintentar."
        action={null}
      />
    )
  }

  if (!eligibility) return null

  if (eligibility.unlimited) {
    return <CreditsPill label="Ilimitado" title="Tu empresa tiene CERP IA Ilimitado — generacion de cotizaciones sin limite" action={null} />
  }

  if (eligibility.blockedReason) {
    return (
      <CreditsPill
        label="Plan inactivo"
        tone="warning"
        title="Tu plan no está activo."
        action={{ label: 'Activa tu plan', href: 'https://app.cerp.es/billing' }}
      />
    )
  }

  const hasFree = eligibility.freeAvailable
  const credits = eligibility.prepaidCredits

  if (hasFree || credits > 0) {
    const parts: string[] = []
    if (hasFree) parts.push('1 cotización gratis')
    if (credits > 0) parts.push(credits === 1 ? '1 disponible' : `${credits} disponibles`)
    return (
      <CreditsPill
        label={parts.join(' + ')}
        title={hasFree && credits > 0 ? 'Tienes la cotización gratis del mes y créditos comprados disponibles' : hasFree ? 'Tienes tu cotización gratis del mes' : 'Cotizaciones compradas disponibles'}
      />
    )
  }

  // Sin gratis ni créditos prepagos NO hay nada que comprar: cotizar sale de los
  // créditos de IA del plan, como cualquier otra acción del agente. El badge lo
  // dice en vez de empujar a una compra que ya no existe.
  return (
    <CreditsPill
      label="Con créditos"
      title="Cotizar consume créditos de IA de tu plan, como el resto de CERP IA."
    />
  )
}
