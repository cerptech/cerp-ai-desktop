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
    <div
      className={[
        'inline-flex h-6 items-center gap-1.5 px-2.5 rounded-full border text-xs font-medium',
        active ? 'bg-primary-50 border-primary-200 text-primary-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700',
      ].join(' ')}
    >
      <span
        className={['inline-block size-1.5 rounded-full', active ? 'bg-brand-orange animate-pulse' : 'bg-success'].join(' ')}
        aria-hidden="true"
      />
      {active ? 'IA trabajando' : 'IA lista'}
    </div>
  )
}
