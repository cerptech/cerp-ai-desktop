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
  // Ventana única (Ola 2): sin barra de título nativa — este header ES la barra
  // de arrastre. `titleBarOverlay` (Windows/Linux) dibuja min/max/cerrar sobre
  // la esquina superior derecha; `hiddenInset` (macOS) deja el semáforo a la
  // izquierda. Reservamos espacio a cada lado para no dibujar debajo.
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
  return (
    <div className="flex flex-col h-screen bg-sidebar">
      {/* Title bar — altura fija de 40px, igual al `height` del titleBarOverlay */}
      <header
        className={`flex h-10 items-center justify-between border-b border-sidebar-border bg-sidebar shrink-0 gap-3 ${isMac ? 'pl-20 pr-4' : 'pl-4 pr-[140px]'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <img src={cerpLogo} alt="CERP" className="w-6 h-6 object-contain" />
          <span className="font-semibold text-brand-black text-[13px]">CERP AI</span>
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
                Cerrar sesión
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
