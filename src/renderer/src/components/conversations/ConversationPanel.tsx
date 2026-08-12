import { useState, useMemo, useRef, useCallback, type MutableRefObject } from 'react'
import { MessageCircle, Trash2, ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react'
import type { ConversationSummary, ApiErrorCode } from '../../../../preload/index'
import { AGENTS } from '@/components/agents/agentConfig'
import { AgentIconGlyph, type AgentIconType } from '@/components/agents/AgentIcon'

const SIDEBAR_WIDTH_KEY = 'cerp-sidebar-width'
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_DEFAULT_WIDTH = 224

interface ConversationPanelProps {
  conversations: ConversationSummary[]
  activeConversationId: string | null
  loading: boolean
  /** 'network' → mostrar error + reintentar. 'auth' → el modal global de sesión
   *  expirada ya se está mostrando, así que acá no se duplica el aviso. */
  error?: ApiErrorCode | null
  onRetry?: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  onDeleteConversation: (id: string) => void
  /** Ref that external callers can use to focus the search input (e.g. Ctrl+K) */
  searchInputRef?: MutableRefObject<HTMLInputElement | null>
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

function getAgentIcon(agentName: string): AgentIconType {
  const agent = AGENTS.find((a) => a.name === agentName)
  return agent?.icon || MessageCircle
}

export function ConversationPanel({
  conversations,
  activeConversationId,
  loading,
  error,
  onRetry,
  collapsed,
  onToggleCollapse,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  searchInputRef,
}: ConversationPanelProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Ancho redimensionable (Ola 2) — arrastrable entre 200 y 360px, persistido
  // en localStorage para que sobreviva a reinicios de la app.
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH
  })
  const resizingRef = useRef(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      if (!resizingRef.current) return
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + (moveEvent.clientX - startX)))
      setWidth(next)
    }
    const handleMouseUp = (): void => {
      resizingRef.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      setWidth((current) => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(current))
        return current
      })
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width])

  const filteredConversations = useMemo(() => {
    if (!search.trim()) return conversations
    const q = search.toLowerCase()
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, search])

  if (collapsed) {
    return (
      <div className="w-12 border-r border-sidebar-border bg-sidebar flex flex-col items-center py-3 gap-2 shrink-0">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg hover:bg-black/5 transition-colors text-slate-500"
          title="Mostrar conversaciones"
        >
          <ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          onClick={onNewConversation}
          className="p-1.5 rounded-lg hover:bg-black/5 transition-colors text-slate-500"
          title="Nueva conversación"
        >
          <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative border-r border-sidebar-border bg-sidebar flex flex-col shrink-0" style={{ width }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-sidebar-border">
        <span className="text-[11px] font-semibold text-slate-600 tracking-[0.04em] uppercase">Conversaciones</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onNewConversation}
            className="p-1 rounded hover:bg-black/5 transition-colors text-slate-500"
            title="Nueva conversación"
          >
            <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded hover:bg-black/5 transition-colors text-slate-500"
            title="Ocultar"
          >
            <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Search */}
      {conversations.length > 0 && (
        <div className="px-2 py-1.5 border-b border-sidebar-border">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-slate-400" strokeWidth={2} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar..."
              className="w-full pl-6 pr-2 py-1 text-[13px] bg-white border border-sidebar-border rounded-md text-slate-700 placeholder:text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="size-3" strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto cerp-scroll p-1.5 space-y-0.5">
        {loading && conversations.length === 0 && (
          <p className="text-[11px] text-slate-400 text-center py-4">Cargando…</p>
        )}

        {/* Error real (red caída, 5xx) — no fingir que no hay conversaciones. El
            caso 'auth' se omite: el modal global de sesión expirada ya lo cubre. */}
        {!loading && error === 'network' && conversations.length === 0 && (
          <div className="text-center py-6">
            <p className="text-[11px] text-red-500">No se pudieron cargar las conversaciones</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="text-[11px] text-brand-orange hover:underline mt-1"
              >
                Reintentar
              </button>
            )}
          </div>
        )}

        {!loading && error !== 'network' && conversations.length === 0 && (
          <div className="text-center py-6">
            <p className="text-[11px] text-slate-400">Sin conversaciones</p>
            <p className="text-[11px] text-slate-300 mt-1">Envía un mensaje para comenzar</p>
          </div>
        )}

        {search && filteredConversations.length === 0 && conversations.length > 0 && (
          <p className="text-[11px] text-slate-400 text-center py-4">Sin resultados</p>
        )}

        {filteredConversations.map((conv) => {
          const isActive = activeConversationId === conv._id
          const isHovered = hoveredId === conv._id
          return (
            // `role="button"` en un div, NO un <button> anidando otro <button>
            // (el de eliminar): un botón dentro de otro botón es HTML inválido
            // y algunos lectores de pantalla solo exponen el interior.
            <div
              key={conv._id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectConversation(conv._id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectConversation(conv._id)
                }
              }}
              onMouseEnter={() => setHoveredId(conv._id)}
              onMouseLeave={() => setHoveredId(null)}
              className={`w-full text-left px-2.5 py-2 rounded-lg transition-all duration-150 group relative cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
                isActive
                  ? 'bg-white shadow-sm border border-sidebar-border'
                  : 'hover:bg-white/70 border border-transparent'
              }`}
            >
              <div className="flex items-start gap-2">
                <AgentIconGlyph icon={getAgentIcon(conv.agentName)} className="size-3.5 mt-0.5 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] font-medium truncate ${isActive ? 'text-slate-800' : 'text-slate-600'}`}>
                    {conv.title}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] text-slate-400">{formatRelativeDate(conv.updatedAt)}</span>
                    <span className="text-[11px] text-slate-300">{conv.messageCount} msg</span>
                  </div>
                </div>
                {/* Eliminar (hover) — botón HERMANO del contenedor, no anidado */}
                {isHovered && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteConversation(conv._id)
                    }}
                    className="absolute right-1.5 top-1.5 p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Eliminar"
                  >
                    <Trash2 className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Drag handle — redimensiona el panel (200–360px), persistido en localStorage */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-brand-orange/30 active:bg-brand-orange/50 transition-colors"
        title="Arrastrar para redimensionar"
      />
    </div>
  )
}
