import { AgentCard } from './AgentCard'
import { AGENTS } from './agentConfig'
import cerpLogo from '@/assets/images/cerp-logo.png'

interface AgentPanelProps {
  selectedAgent: string
  activeAgents: string[]
  doneAgents: string[]
  onSelectAgent: (name: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function AgentPanel({
  selectedAgent,
  activeAgents,
  doneAgents,
  onSelectAgent,
  collapsed,
  onToggleCollapse,
}: AgentPanelProps) {
  if (collapsed) {
    return (
      <div className="w-12 border-r border-slate-200 bg-white flex flex-col items-center py-3 gap-2 shrink-0">
        <button onClick={onToggleCollapse} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors" title="Expandir panel de agentes">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <div className="w-6 h-px bg-slate-200 my-1" />
        {AGENTS.map((agent) => {
          const isActive = activeAgents.includes(agent.name)
          const isDone = doneAgents.includes(agent.name)
          const isSelected = selectedAgent === agent.name
          return (
            <button
              key={agent.name}
              onClick={() => onSelectAgent(agent.name)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all ${
                isSelected ? 'bg-orange-50 ring-1 ring-brand-orange/30' : 'hover:bg-slate-100'
              } ${isActive ? 'animate-pulse' : ''}`}
              title={agent.label}
            >
              {agent.icon}
              {isActive && <span className="absolute w-1.5 h-1.5 bg-brand-orange rounded-full -top-0.5 -right-0.5" />}
              {isDone && <span className="absolute text-[8px] text-emerald-500 -top-0.5 -right-0.5">&#10003;</span>}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="w-56 border-r border-slate-200 bg-white flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <img src={cerpLogo} alt="CERP" className="w-5 h-5 object-contain" />
          <span className="text-xs font-semibold text-slate-700">Agentes</span>
        </div>
        <button onClick={onToggleCollapse} className="p-1 rounded hover:bg-slate-100 transition-colors" title="Colapsar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {AGENTS.map((agent) => {
          const status = activeAgents.includes(agent.name) ? 'active' : doneAgents.includes(agent.name) ? 'done' : 'idle'
          return (
            <AgentCard
              key={agent.name}
              name={agent.name}
              label={agent.label}
              description={agent.description}
              icon={agent.icon}
              status={status}
              isSelected={selectedAgent === agent.name}
              onSelect={() => onSelectAgent(agent.name)}
            />
          )
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-slate-100">
        <p className="text-[9px] text-slate-300 text-center">
          Selecciona un agente o deja que CERP AI decida
        </p>
      </div>
    </div>
  )
}
