import { useEffect, useState } from 'react'
import { QuoteStatusBadge } from './QuoteStatusBadge'
import { CreditsPill, SUBSCRIPTION_URL } from './CreditsPill'
import { resolveUnitsPerCredit, unitsToCredits } from '../../utils/creditUnits'

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
  /** Unidades por crédito para esta empresa (lo decide el core; ausente = 100). */
  unitsPerCredit?: number
  /** Aviso de saldo bajo calculado en el core (misma regla en todas las superficies). */
  lowBalance?: { isLow: boolean }
}

const REFRESH_INTERVAL_MS = 60_000
const LOW_BALANCE_RATIO = 0.2

/** Unidades → créditos con 1 decimal (ej. 4750 con divisor 100 → "47.5"). */
function formatCredits(units: number, unitsPerCredit: number): string {
  return unitsToCredits(units, unitsPerCredit).toFixed(1)
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
    return <CreditsPill label="Ilimitado" title="Tu empresa tiene CERP IA Ilimitado — sin límite de créditos" action={null} />
  }

  const available = balance.availableHundredths
  const monthly = balance.monthlyCreditHundredths

  if (available <= 0) {
    return (
      <CreditsPill
        label="Sin créditos"
        tone="danger"
        title="Tu empresa no tiene créditos de IA disponibles"
        action={{ label: 'Recargar', href: SUBSCRIPTION_URL }}
      />
    )
  }

  // El aviso es un cociente entre unidades: no depende del divisor. Si el core
  // ya lo manda (`lowBalance`), manda el core; con un core sin ese campo, la
  // regla local de siempre (el mismo 20 %).
  const isLow = balance.lowBalance
    ? balance.lowBalance.isLow
    : monthly > 0 && available / monthly < LOW_BALANCE_RATIO
  const unitsPerCredit = resolveUnitsPerCredit(balance.unitsPerCredit)

  return (
    <CreditsPill
      label={`${formatCredits(available, unitsPerCredit)} créditos`}
      tone={isLow ? 'warning' : 'neutral'}
      title={isLow ? 'Te quedan pocos créditos de IA este mes' : 'Créditos de IA disponibles'}
    />
  )
}
