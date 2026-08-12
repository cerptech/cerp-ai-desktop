import { AgentCard } from './AgentCard'
import { ContextCard } from './ContextCard'
import { AgentIconGlyph } from './AgentIcon'
import { AGENTS } from './agentConfig'
import cerpLogo from '@/assets/images/cerp-logo.png'
import type { CustomAgent, CustomContext } from '../../../../preload/index'

interface AgentPanelProps {
  selectedAgent: string
  activeAgents: string[]
  doneAgents: string[]
  agentTasks: Record<string, string>
  onSelectAgent: (name: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  customAgents?: CustomAgent[]
  customContexts?: CustomContext[]
  activeContextId?: string | null
  onSelectContext?: (id: string | null) => void
  onAddCustom?: () => void
}

export function AgentPanel({
  selectedAgent,
  activeAgents,
  doneAgents,
  agentTasks,
  onSelectAgent,
  collapsed,
  onToggleCollapse,
  customAgents = [],
  customContexts = [],
  activeContextId,
  onSelectContext,
  onAddCustom,
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
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all relative ${
                isSelected ? 'bg-orange-50 ring-1 ring-brand-orange/30' : 'hover:bg-slate-100'
              } ${isActive ? 'animate-pulse' : ''}`}
              title={agent.label}
            >
              <AgentIconGlyph icon={agent.icon} className={typeof agent.icon === 'string' ? '' : 'size-4 text-slate-600'} />
              {isActive && <span className="absolute w-2 h-2 bg-brand-orange rounded-full -top-0.5 -right-0.5 shadow-[0_0_6px_rgba(254,112,11,0.4)]" />}
              {isDone && <span className="absolute text-[8px] text-emerald-500 -top-0.5 -right-0.5">&#10003;</span>}
            </button>
          )
        })}
        {/* Custom agents collapsed icons */}
        {(customAgents.length > 0 || customContexts.length > 0) && (
          <>
            <div className="w-6 h-px bg-slate-200 my-1" />
            {customAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => onSelectAgent(agent.name)}
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all ${
                  selectedAgent === agent.name ? 'bg-orange-50 ring-1 ring-brand-orange/30' : 'hover:bg-slate-100'
                }`}
                title={agent.label}
              >
                {agent.icon}
              </button>
            ))}
            {customContexts.map((ctx) => (
              <button
                key={ctx.id}
                onClick={() => onSelectContext?.(activeContextId === ctx.id ? null : ctx.id)}
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-all ${
                  activeContextId === ctx.id ? 'bg-purple-50 ring-1 ring-purple-300' : 'hover:bg-slate-100'
                }`}
                title={ctx.name}
              >
                {ctx.icon}
              </button>
            ))}
          </>
        )}
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
              currentTask={agentTasks[agent.name]}
            />
          )
        })}

        {/* Custom section */}
        {(customAgents.length > 0 || customContexts.length > 0 || onAddCustom) && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <div className="flex items-center justify-between px-1 mb-1.5">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Personalizados</span>
              {onAddCustom && (
                <button
                  onClick={onAddCustom}
                  className="text-slate-400 hover:text-brand-orange transition-colors p-0.5 rounded hover:bg-orange-50"
                  title="Agregar agente o contexto"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              )}
            </div>

            {/* Custom agents */}
            {customAgents.map((agent) => {
              const status = activeAgents.includes(agent.name) ? 'active' : doneAgents.includes(agent.name) ? 'done' : 'idle'
              return (
                <AgentCard
                  key={agent.id}
                  name={agent.name}
                  label={agent.label}
                  description={agent.description}
                  icon={agent.icon}
                  status={status}
                  isSelected={selectedAgent === agent.name}
                  onSelect={() => onSelectAgent(agent.name)}
                  currentTask={agentTasks[agent.name]}
                />
              )
            })}

            {/* Custom contexts */}
            {customContexts.map((ctx) => (
              <ContextCard
                key={ctx.id}
                context={ctx}
                isActive={activeContextId === ctx.id}
                onToggle={() => onSelectContext?.(activeContextId === ctx.id ? null : ctx.id)}
              />
            ))}

            {customAgents.length === 0 && customContexts.length === 0 && (
              <p className="text-[10px] text-slate-300 text-center py-2">
                Sin personalizados
              </p>
            )}
          </div>
        )}
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
