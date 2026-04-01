import { ReactNode } from 'react'
import cerpLogo from '@/assets/images/cerp-logo.png'

interface AppLayoutProps {
  children: ReactNode
  userName?: string
  onLogout?: () => void
  agentTags?: ReactNode
}

export function AppLayout({ children, userName, onLogout, agentTags }: AppLayoutProps) {
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

        {/* Agent tags in center */}
        {agentTags && (
          <div className="flex-1 min-w-0 mx-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {agentTags}
          </div>
        )}

        {userName && (
          <div className="flex items-center gap-3 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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

      {/* Main content */}
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  )
}
