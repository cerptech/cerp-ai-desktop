import { QUICK_ACTIONS } from '@/constants/quickActions'

interface QuickActionsProps {
  onSelect: (prompt: string) => void
  disabled?: boolean
}

const ICONS: Record<string, string> = {
  document: '\u{1F4D0}',
  search: '\u{1F50D}',
  clipboard: '\u{1F4CB}',
  chart: '\u{1F4CA}',
  cart: '\u{1F6D2}',
  alert: '\u{26A0}',
  users: '\u{1F477}',
}

export function QuickActions({ onSelect, disabled }: QuickActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 max-w-2xl mx-auto">
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          onClick={() => onSelect(action.prompt)}
          disabled={disabled}
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200 hover:border-brand-orange/40 hover:bg-orange-50/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed group"
        >
          <span className="text-2xl" role="img" aria-label={action.icon}>
            {ICONS[action.icon] || ''}
          </span>
          <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
            {action.label}
          </span>
        </button>
      ))}
    </div>
  )
}
