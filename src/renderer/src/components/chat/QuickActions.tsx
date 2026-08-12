import type { LucideIcon } from 'lucide-react'
import { FileText, Search, ClipboardList, BarChart3, ShoppingCart, TriangleAlert } from 'lucide-react'
import { QUICK_ACTIONS } from '@/constants/quickActions'

interface QuickActionsProps {
  onSelect: (prompt: string) => void
  disabled?: boolean
}

const ICONS: Record<string, LucideIcon> = {
  document: FileText,
  search: Search,
  clipboard: ClipboardList,
  chart: BarChart3,
  cart: ShoppingCart,
  alert: TriangleAlert,
}

export function QuickActions({ onSelect, disabled }: QuickActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 max-w-2xl mx-auto">
      {QUICK_ACTIONS.map((action) => {
        const Icon = ICONS[action.icon]
        return (
          <button
            key={action.label}
            onClick={() => onSelect(action.prompt)}
            disabled={disabled}
            className="flex items-center gap-3 p-4 bg-white rounded-2xl border border-composer-border hover:border-brand-orange/40 hover:bg-orange-50/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            {Icon && <Icon className="size-5 shrink-0 text-brand-orange" strokeWidth={2} aria-hidden="true" />}
            <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
              {action.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
