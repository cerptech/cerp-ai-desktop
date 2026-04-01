interface AgentCardProps {
  name: string
  label: string
  description: string
  icon: string
  status: 'idle' | 'active' | 'done'
  isSelected: boolean
  onSelect: () => void
  currentTask?: string
}

export function AgentCard({ name, label, description, icon, status, isSelected, onSelect, currentTask }: AgentCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group relative overflow-hidden ${
        isSelected
          ? 'border-brand-orange bg-orange-50/80 shadow-sm'
          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50/50'
      }`}
    >
      {/* Active indicator bar */}
      {status === 'active' && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-brand-orange rounded-l-xl" />
      )}

      <div className="flex items-start gap-2.5">
        {/* Avatar */}
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0 transition-all ${
            status === 'active'
              ? 'bg-brand-orange/15 ring-2 ring-brand-orange/30 animate-pulse'
              : isSelected
                ? 'bg-brand-orange/10'
                : 'bg-slate-100 group-hover:bg-slate-200/70'
          }`}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          {/* Name + status */}
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-semibold truncate ${isSelected ? 'text-brand-orange' : 'text-slate-700'}`}>
              {label}
            </span>
            {status === 'active' && (
              <span className="w-2 h-2 rounded-full bg-brand-orange animate-pulse shrink-0 shadow-[0_0_6px_rgba(254,112,11,0.4)]" />
            )}
            {status === 'done' && (
              <span className="text-[10px] text-emerald-500 shrink-0">&#10003;</span>
            )}
          </div>

          {/* Description or current task */}
          {status === 'active' && currentTask ? (
            <p className="text-[10px] text-brand-orange/80 mt-0.5 line-clamp-2 leading-tight italic">
              {currentTask}
            </p>
          ) : (
            <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2 leading-tight">
              {description}
            </p>
          )}
        </div>
      </div>
    </button>
  )
}
