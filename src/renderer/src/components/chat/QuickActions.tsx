import type { LucideIcon } from 'lucide-react'
import { FileText, Search, ClipboardList, BarChart3, ShoppingCart, TriangleAlert, RotateCw } from 'lucide-react'
import { QUICK_ACTIONS } from '@/constants/quickActions'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

interface ToolsSetupInfo {
  ready: boolean
  preparing: boolean
  status: 'idle' | 'checking' | 'installing' | 'ready' | 'error'
  percent: number
  retry: () => void
}

interface QuickActionsProps {
  onSelect: (prompt: string) => void
  disabled?: boolean
  /** Estado de Git/Python (Ola 3) — gatea las acciones con `requiresTools`. */
  toolsSetup?: ToolsSetupInfo
}

const ICONS: Record<string, LucideIcon> = {
  document: FileText,
  search: Search,
  clipboard: ClipboardList,
  chart: BarChart3,
  cart: ShoppingCart,
  alert: TriangleAlert,
}

export function QuickActions({ onSelect, disabled, toolsSetup }: QuickActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 max-w-2xl mx-auto">
      {QUICK_ACTIONS.map((action) => {
        const Icon = ICONS[action.icon]
        const gated = action.requiresTools && toolsSetup && !toolsSetup.ready
        const isPreparing = !!gated && toolsSetup!.preparing
        const hasFailed = !!gated && toolsSetup!.status === 'error'

        return (
          <button
            key={action.label}
            onClick={() => {
              if (hasFailed) { toolsSetup!.retry(); return }
              if (isPreparing) return
              onSelect(action.prompt)
            }}
            disabled={disabled || isPreparing}
            title={
              isPreparing
                ? `Preparando herramientas… ${Math.round(toolsSetup!.percent)}%`
                : hasFailed
                  ? 'No se pudieron preparar las herramientas necesarias. Click para reintentar.'
                  : undefined
            }
            className="flex items-center gap-3 p-4 bg-white rounded-2xl border border-composer-border hover:border-brand-orange/40 hover:bg-orange-50/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            {isPreparing ? (
              <LoadingSpinner size="sm" />
            ) : hasFailed ? (
              <RotateCw className="size-5 shrink-0 text-error" strokeWidth={2} aria-hidden="true" />
            ) : (
              Icon && <Icon className="size-5 shrink-0 text-brand-orange" strokeWidth={2} aria-hidden="true" />
            )}
            <div className="min-w-0">
              <span className="block text-sm font-medium text-slate-700 group-hover:text-slate-900">
                {action.label}
              </span>
              {isPreparing && (
                <span className="block text-[11px] text-slate-400 mt-0.5">
                  Preparando herramientas… {Math.round(toolsSetup!.percent)}%
                </span>
              )}
              {hasFailed && (
                <span className="block text-[11px] text-error mt-0.5">
                  No disponible · Reintentar
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
