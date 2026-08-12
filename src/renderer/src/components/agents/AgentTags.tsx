import { AGENTS } from './agentConfig'
import { AgentIconGlyph } from './AgentIcon'
import type { CustomAgent, CustomContext } from '../../../../preload/index'

interface AgentTagsProps {
  activeAgents: string[]
  doneAgents: string[]
  customAgents: CustomAgent[]
  customContexts: CustomContext[]
  activeContextId: string | null
  onEditAgent: (agent: CustomAgent) => void
  onEditContext: (context: CustomContext) => void
  onToggleContext: (id: string) => void
  onAdd: () => void
}

export function AgentTags({
  activeAgents,
  doneAgents,
  customAgents,
  customContexts,
  activeContextId,
  onEditAgent,
  onEditContext,
  onToggleContext,
  onAdd,
}: AgentTagsProps) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
      {/* Built-in agents */}
      {AGENTS.map((agent) => {
        const isActive = activeAgents.includes(agent.name)
        const isDone = doneAgents.includes(agent.name)
        return (
          <div
            key={agent.name}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap transition-all duration-300 select-none ${
              isActive
                ? 'bg-brand-orange/15 text-brand-orange ring-1 ring-brand-orange/30 shadow-[0_0_8px_rgba(254,112,11,0.15)]'
                : isDone
                  ? 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200'
                  : 'bg-slate-100 text-slate-400'
            }`}
            title={agent.description}
          >
            <AgentIconGlyph icon={agent.icon} className="size-3" />
            <span>{agent.label}</span>
            {isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse" />
            )}
            {isDone && !isActive && (
              <span className="text-[8px] text-emerald-500">&#10003;</span>
            )}
          </div>
        )
      })}

      {/* Custom agents */}
      {customAgents.map((agent) => {
        const isActive = activeAgents.includes(agent.name)
        const isDone = doneAgents.includes(agent.name)
        return (
          <button
            key={agent.id}
            onClick={() => onEditAgent(agent)}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap transition-all duration-300 cursor-pointer hover:ring-1 hover:ring-brand-orange/40 ${
              isActive
                ? 'bg-brand-orange/15 text-brand-orange ring-1 ring-brand-orange/30 shadow-[0_0_8px_rgba(254,112,11,0.15)]'
                : isDone
                  ? 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
            title={`Editar: ${agent.label}`}
          >
            <span className="text-xs">{agent.icon}</span>
            <span>{agent.label}</span>
            {isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse" />
            )}
          </button>
        )
      })}

      {/* Custom contexts */}
      {customContexts.map((ctx) => (
        <button
          key={ctx.id}
          onClick={() => onToggleContext(ctx.id)}
          onDoubleClick={() => onEditContext(ctx)}
          className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap transition-all duration-300 border border-dashed ${
            activeContextId === ctx.id
              ? 'border-purple-300 bg-purple-50 text-purple-600'
              : 'border-slate-300 bg-white text-slate-500 hover:border-purple-300 hover:bg-purple-50/30'
          }`}
          title={activeContextId === ctx.id ? 'Click: desactivar | Doble-click: editar' : 'Click: activar | Doble-click: editar'}
        >
          <span className="text-xs">{ctx.icon}</span>
          <span>{ctx.name}</span>
        </button>
      ))}

    </div>
  )
}
