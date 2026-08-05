import { useEffect, useState } from 'react'
import { QuoteStatusBadge } from './QuoteStatusBadge'

/**
 * Balance de créditos de IA de la empresa (Modelo CERP).
 * Sustituye a QuoteStatusBadge en el header cuando el backend ya tiene el modo de
 * créditos activo (`shadow` o `enforce`). Con `mode:'off'` o si el fetch falla —
 * backend viejo, red caída, etc. — el fallback es TOTAL: se renderiza el badge de
 * cotizaciones de siempre, sin ningún estado intermedio propio.
 */

interface CreditsBalance {
  mode: 'off' | 'shadow' | 'enforce'
  plan: string
  unlimited: boolean
  planBalanceHundredths: number
  topupBalanceHundredths: number
  reservedHundredths: number
  availableHundredths: number
  monthlyCreditHundredths: number
}

const REFRESH_INTERVAL_MS = 60_000
const LOW_BALANCE_RATIO = 0.2

/** Céntimas de crédito → créditos con 1 decimal (ej. 4750 → "47.5"). */
function formatCredits(hundredths: number): string {
  return (hundredths / 100).toFixed(1)
}

export function CreditBalanceBadge() {
  const [balance, setBalance] = useState<CreditsBalance | null>(null)
  // Aún no resolvimos el primer fetch — durante este tramo delegamos por completo
  // en QuoteStatusBadge (que tiene su propio estado de carga) para no mostrar dos
  // indicadores de "cargando" distintos en el mismo lugar.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await window.cerpAPI.getCreditsBalance()
        if (!cancelled) setBalance(result)
      } catch {
        if (!cancelled) setBalance(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    }

    load()
    const interval = setInterval(load, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Fallback total: sin respuesta todavía, error de fetch, o modo apagado.
  if (!ready || !balance || balance.mode === 'off') {
    return <QuoteStatusBadge />
  }

  if (balance.unlimited) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-50 text-violet-700 text-xs"
        title="Tu empresa tiene CERP IA Ilimitado — sin límite de créditos"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
        Ilimitado
      </div>
    )
  }

  const available = balance.availableHundredths
  const monthly = balance.monthlyCreditHundredths

  if (available <= 0) {
    return (
      <a
        href="https://app.cerp.es/settings/subscription"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 text-red-700 hover:bg-red-100 text-xs transition-colors"
        title="Tu empresa no tiene créditos de IA disponibles. Click para recargar."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Sin créditos
      </a>
    )
  }

  const isLow = monthly > 0 && available / monthly < LOW_BALANCE_RATIO

  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs ${
        isLow ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
      }`}
      title={isLow ? 'Te quedan pocos créditos de IA este mes' : 'Créditos de IA disponibles'}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isLow ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      {formatCredits(available)} créditos
    </div>
  )
}
