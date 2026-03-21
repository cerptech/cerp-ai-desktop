interface AgentCardProps {
  name: string
  label: string
  description: string
  icon: string
  status: 'idle' | 'active' | 'done'
  isSelected: boolean
  onSelect: () => void
}

export function AgentCard({ name, label, description, icon, status, isSelected, onSelect }: AgentCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-3 rounded-xl border transition-all duration-200 group ${
        isSelected
          ? 'border-brand-orange bg-orange-50/80 shadow-sm'
          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50/50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* Avatar */}
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0 ${
            status === 'active'
              ? 'bg-brand-orange/10 animate-pulse'
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
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse shrink-0" />
            )}
            {status === 'done' && (
              <span className="text-[10px] text-emerald-500 shrink-0">&#10003;</span>
            )}
          </div>

          {/* Description */}
          <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2 leading-tight">
            {description}
          </p>
        </div>
      </div>
    </button>
  )
}
