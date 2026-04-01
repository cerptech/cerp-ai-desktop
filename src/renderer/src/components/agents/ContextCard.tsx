import type { CustomContext } from '../../../../preload/index'

interface ContextCardProps {
  context: CustomContext
  isActive: boolean
  onToggle: () => void
}

export function ContextCard({ context, isActive, onToggle }: ContextCardProps) {
  return (
    <button
      onClick={onToggle}
      className={`w-full text-left p-3 rounded-xl border-2 border-dashed transition-all duration-200 group ${
        isActive
          ? 'border-purple-300 bg-purple-50/80 shadow-sm'
          : 'border-slate-200 hover:border-purple-200 hover:bg-purple-50/30'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0 ${
            isActive ? 'bg-purple-100' : 'bg-slate-100 group-hover:bg-purple-50'
          }`}
        >
          {context.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-semibold truncate ${isActive ? 'text-purple-600' : 'text-slate-700'}`}>
              {context.name}
            </span>
            {isActive && (
              <span className="text-[9px] font-medium text-purple-500 bg-purple-100 rounded px-1 py-0.5">
                Activo
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2 leading-tight">
            {context.instructions.substring(0, 80)}{context.instructions.length > 80 ? '...' : ''}
          </p>
        </div>
      </div>
    </button>
  )
}
