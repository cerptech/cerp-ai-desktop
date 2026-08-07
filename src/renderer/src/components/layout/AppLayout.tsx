import { ReactNode, useState } from 'react'
import cerpLogo from '@/assets/images/cerp-logo.png'
import { CreditBalanceBadge } from './CreditBalanceBadge'
import { QuoteFirewallBanner } from './QuoteFirewallBanner'
import { CreditHistoryPanel } from './CreditHistoryPanel'
import { SessionStatusBadge } from './SessionStatusBadge'

interface AppLayoutProps {
  children: ReactNode
  userName?: string
  onLogout?: () => void
  /** Whether the agent session is actively working (streaming or pending). */
  sessionActive?: boolean
  /** Opens the onboarding guided tutorial on demand ("Cómo empezar"). */
  onShowOnboarding?: () => void
}

export function AppLayout({ children, userName, onLogout, sessionActive = false, onShowOnboarding }: AppLayoutProps) {
  const [showHistory, setShowHistory] = useState(false)
  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Title bar */}
      <header className="flex items-center justify-between px-4 py-2 bg-white border-b border-slate-200 shrink-0 gap-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <img src={cerpLogo} alt="CERP" className="w-7 h-7 object-contain" />
          <span className="font-semibold text-slate-800 text-sm">CERP AI</span>
        </div>

        {/* Session activity indicator in center */}
        <div className="flex-1 flex justify-center min-w-0 mx-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SessionStatusBadge active={sessionActive} />
        </div>

        {userName && (
          <div className="flex items-center gap-3 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {onShowOnboarding && (
              <button
                onClick={onShowOnboarding}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-orange transition-colors"
                title="Ver el tutorial guiado para empezar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
                Cómo empezar
              </button>
            )}
            <CreditBalanceBadge />
            <button
              onClick={() => setShowHistory(true)}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              title="Ver historial de cotizaciones y consumo de créditos"
            >
              Historial
            </button>
            <span className="text-xs text-slate-500">{userName}</span>
            {onLogout && (
              <button
                onClick={onLogout}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Cerrar sesion
              </button>
            )}
          </div>
        )}
      </header>

      {/* Cortafuegos de cotización — estado en vivo (reserva/commit/rollback) */}
      <QuoteFirewallBanner />

      {/* Main content */}
      <main className="flex-1 overflow-hidden">{children}</main>

      {showHistory && <CreditHistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  )
}
