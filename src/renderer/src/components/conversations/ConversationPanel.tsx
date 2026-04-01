import { useState, useMemo } from 'react'
import type { ConversationSummary } from '../../../../preload/index'
import { AGENTS } from '@/components/agents/agentConfig'

interface ConversationPanelProps {
  conversations: ConversationSummary[]
  activeConversationId: string | null
  loading: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  onDeleteConversation: (id: string) => void
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return 'Ahora'
  if (diffMin < 60) return `${diffMin}m`
  if (diffHr < 24) return `${diffHr}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
}

function getAgentIcon(agentName: string): string {
  const agent = AGENTS.find((a) => a.name === agentName)
  return agent?.icon || '\u{1F4AC}'
}

export function ConversationPanel({
  conversations,
  activeConversationId,
  loading,
  collapsed,
  onToggleCollapse,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
}: ConversationPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const filteredConversations = useMemo(() => {
    if (!search.trim()) return conversations
    const q = search.toLowerCase()
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, search])

  if (collapsed) {
    return (
      <div className="w-12 border-r border-slate-200 bg-slate-50 flex flex-col items-center py-3 gap-2 shrink-0">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg hover:bg-slate-200 transition-colors text-slate-500"
          title="Mostrar conversaciones"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          onClick={onNewConversation}
          className="p-1.5 rounded-lg hover:bg-slate-200 transition-colors text-slate-500"
          title="Nueva conversacion"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div className="w-52 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-slate-200">
        <span className="text-xs font-semibold text-slate-600">Conversaciones</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onNewConversation}
            className="p-1 rounded hover:bg-slate-200 transition-colors text-slate-500"
            title="Nueva conversacion"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded hover:bg-slate-200 transition-colors text-slate-500"
            title="Ocultar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      {conversations.length > 0 && (
        <div className="px-2 py-1.5 border-b border-slate-100">
          <div className="relative">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar..."
              className="w-full pl-6 pr-2 py-1 text-[10px] bg-white border border-slate-200 rounded-md text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-orange/30 focus:border-brand-orange/50"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {loading && conversations.length === 0 && (
          <p className="text-[10px] text-slate-400 text-center py-4">Cargando...</p>
        )}

        {!loading && conversations.length === 0 && (
          <div className="text-center py-6">
            <p className="text-[10px] text-slate-400">Sin conversaciones</p>
            <p className="text-[10px] text-slate-300 mt-1">Envia un mensaje para comenzar</p>
          </div>
        )}

        {search && filteredConversations.length === 0 && conversations.length > 0 && (
          <p className="text-[10px] text-slate-400 text-center py-4">Sin resultados</p>
        )}

        {filteredConversations.map((conv) => {
          const isActive = activeConversationId === conv._id
          const isHovered = hoveredId === conv._id
          return (
            <button
              key={conv._id}
              onClick={() => onSelectConversation(conv._id)}
              onMouseEnter={() => setHoveredId(conv._id)}
              onMouseLeave={() => setHoveredId(null)}
              className={`w-full text-left px-2.5 py-2 rounded-lg transition-all duration-150 group relative ${
                isActive
                  ? 'bg-white shadow-sm border border-slate-200'
                  : 'hover:bg-white/70 border border-transparent'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5 shrink-0">{getAgentIcon(conv.agentName)}</span>
                <div className="min-w-0 flex-1">
                  <p className={`text-[11px] font-medium truncate ${isActive ? 'text-slate-800' : 'text-slate-600'}`}>
                    {conv.title}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] text-slate-400">{formatRelativeDate(conv.updatedAt)}</span>
                    <span className="text-[9px] text-slate-300">{conv.messageCount} msg</span>
                  </div>
                </div>
                {/* Delete button on hover */}
                {isHovered && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteConversation(conv._id)
                    }}
                    className="absolute right-1.5 top-1.5 p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Eliminar"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
