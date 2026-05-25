interface SessionStatusBadgeProps {
  active: boolean
}

/**
 * Header badge that signals whether the agent session is currently working
 * (thinking, tool-calling, streaming) or idle. Replaces the row of subagent
 * tabs in the top bar — those weren't doing anything actionable and are now
 * surfaced inside the chat (ToolIndicator) when relevant.
 */
export function SessionStatusBadge({ active }: SessionStatusBadgeProps) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200">
      <span
        className={[
          'inline-block w-2 h-2 rounded-full transition-colors',
          active ? 'bg-brand-orange animate-pulse' : 'bg-slate-300',
        ].join(' ')}
        aria-hidden="true"
      />
      <span className={['text-xs font-medium', active ? 'text-brand-orange' : 'text-slate-500'].join(' ')}>
        {active ? 'IA trabajando' : 'IA inactiva'}
      </span>
    </div>
  )
}
