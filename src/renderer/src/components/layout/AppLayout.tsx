import { ReactNode } from 'react'

interface AppLayoutProps {
  children: ReactNode
  userName?: string
  onLogout?: () => void
}

export function AppLayout({ children, userName, onLogout }: AppLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Title bar */}
      <header className="flex items-center justify-between px-6 py-3 bg-white border-b border-slate-200 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="w-8 h-8 rounded-lg bg-brand-orange flex items-center justify-center">
            <span className="text-white font-bold text-sm">C</span>
          </div>
          <span className="font-semibold text-slate-800 text-sm">CERP AI</span>
        </div>

        {userName && (
          <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
