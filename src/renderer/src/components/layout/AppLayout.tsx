import { ReactNode, useState } from 'react'
import { CircleHelp, Plug } from 'lucide-react'
import cerpLogo from '@/assets/images/cerp-logo.png'
import { CreditBalanceBadge } from './CreditBalanceBadge'
import { CreditHistoryPanel } from './CreditHistoryPanel'
import { SessionStatusBadge } from './SessionStatusBadge'
import { AccountMenu } from './AccountMenu'
import { ConnectedAppsPanel } from '../integrations/ConnectedAppsPanel'

interface AppLayoutProps {
  children: ReactNode
  userName?: string
  userEmail?: string
  onLogout?: () => void
  /** Whether the agent session is actively working (streaming or pending). */
  sessionActive?: boolean
  /** Opens the onboarding guided tutorial on demand ("Cómo empezar"). */
  onShowOnboarding?: () => void
}

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export function AppLayout({ children, userName, userEmail, onLogout, sessionActive = false, onShowOnboarding }: AppLayoutProps) {
  const [showHistory, setShowHistory] = useState(false)
  const [showApps, setShowApps] = useState(false)
  // Ventana única (Ola 2): sin barra de título nativa — este header ES la barra
  // de arrastre. `titleBarOverlay` (Windows/Linux) dibuja min/max/cerrar sobre
  // la esquina superior derecha; `hiddenInset` (macOS) deja el semáforo a la
  // izquierda. Reservamos espacio a cada lado para no dibujar debajo.
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
  return (
    <div className="flex flex-col h-screen bg-sidebar">
      {/* Title bar — 48px, igual al `height` del titleBarOverlay (main/index.ts) */}
      <header
        className={`flex h-12 items-center gap-3 border-b border-zinc-200 bg-white shrink-0 ${isMac ? 'pl-20 pr-4' : 'pl-4 pr-[150px]'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 shrink-0" style={NO_DRAG}>
          <img src={cerpLogo} alt="CERP" className="w-6 h-6 object-contain" />
          <span className="font-semibold text-brand-black text-[13px]">CERP AI</span>
        </div>

        <div className="shrink-0" style={NO_DRAG}>
          <SessionStatusBadge active={sessionActive} />
        </div>

        <div className="flex-1" />

        {userName && (
          <div className="flex items-center gap-2 shrink-0" style={NO_DRAG}>
            <button
              type="button"
              onClick={() => setShowApps(true)}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-composer-border bg-white px-3 text-xs font-medium text-[#3f3f46] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-brand-orange/40"
              title="Conectar Gmail, Calendar, Drive y otras apps para que CERP AI pueda usarlas"
            >
              <Plug className="size-3.5" strokeWidth={2} aria-hidden="true" />
              Apps
            </button>
            <CreditBalanceBadge />
            {onShowOnboarding && (
              <button
                type="button"
                onClick={onShowOnboarding}
                aria-label="Cómo empezar"
                title="Cómo empezar"
                className="inline-flex size-[30px] items-center justify-center rounded-full border border-composer-border bg-white text-[#52525b] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-brand-orange/40"
              >
                <CircleHelp className="size-[15px]" strokeWidth={2} aria-hidden="true" />
              </button>
            )}
            <AccountMenu userName={userName} userEmail={userEmail} onShowHistory={() => setShowHistory(true)} onLogout={onLogout} />
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">{children}</main>

      {showHistory && <CreditHistoryPanel onClose={() => setShowHistory(false)} />}
      {showApps && <ConnectedAppsPanel onClose={() => setShowApps(false)} />}
    </div>
  )
}
