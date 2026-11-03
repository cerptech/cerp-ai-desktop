import { useEffect, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, ListTodo, PanelRight, Terminal, Workflow, X } from 'lucide-react'
import { AGENTS } from './agentConfig'
import { AgentIconGlyph, type AgentIconType } from './AgentIcon'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { StepStatusIcon, SubagentStepRow } from '@/components/chat/StepParts'
import { useConversationAgents } from '@/hooks/useConversationAgents'
import { useElapsed, formatDuration } from '@/hooks/useElapsed'
import { abort as storeAbort, getRuntime } from '@/stores/agentRuntimeStore'
import { countRunningEntries, type AgentEntry } from '@/stores/agentsPanel'
import { getToolHumanLabel } from '@/utils/toolUtils'

/** Ancho del panel: el mismo rango que la barra de conversaciones (248 px por defecto). */
const PANEL_WIDTH = 296

/**
 * Conversaciones en las que el panel ya se abrió solo (en esta sesión de la app). Se abre
 * solo la PRIMERA vez que el orquestador delega en cada conversación; después lo maneja
 * el usuario con el botón del encabezado.
 */
const autoOpened = new Set<string>()

/** Nombres que el SDK usa para el agente genérico: se muestran como «Agente». */
const GENERIC_AGENT_NAMES = new Set(['', 'agente', 'general-purpose'])

function entryIdentity(entry: AgentEntry): { label: string; icon: AgentIconType } {
  if (entry.kind === 'workflow') return { label: 'Flujo de trabajo', icon: Workflow }
  if (entry.kind === 'shell') return { label: 'Comando en segundo plano', icon: Terminal }
  if (entry.kind === 'task') return { label: 'Tarea en segundo plano', icon: ListTodo }
  const name = entry.agentName?.trim() ?? ''
  const known = AGENTS.find((a) => a.name === name)
  if (known) return { label: known.label, icon: known.icon }
  return { label: GENERIC_AGENT_NAMES.has(name.toLowerCase()) ? 'Agente' : name, icon: Bot }
}

function stepCountLabel(n: number): string {
  return `${n} paso${n !== 1 ? 's' : ''}`
}

/** Estado de la fila con el mismo lenguaje que las tarjetas del chat (ToolIndicator). */
function EntryStatus({ entry }: { entry: AgentEntry }) {
  const running = entry.status === 'running'
  const elapsed = useElapsed(entry.startTime, running)
  if (running && entry.awaitingUser) {
    return <span className="text-[10px] text-slate-400 shrink-0">Esperando tu respuesta</span>
  }
  if (running) {
    return (
      <span className="flex items-center gap-1 shrink-0">
        <LoadingSpinner size="sm" />
        <span className="text-[10px] text-slate-400">{formatDuration(elapsed)}</span>
      </span>
    )
  }
  // Interrumpido: sin duración (contaría hasta el cierre del turno, no lo que trabajó).
  const duration = entry.status !== 'interrupted' && entry.endTime ? entry.endTime - entry.startTime : null
  return (
    <span className="flex items-center gap-1 shrink-0">
      <StepStatusIcon status={entry.status} />
      {entry.status === 'interrupted' && <span className="text-[10px] text-slate-400">Interrumpido</span>}
      {duration !== null && <span className="text-[10px] text-slate-400">{formatDuration(duration)}</span>}
    </span>
  )
}

interface AgentRowProps {
  entry: AgentEntry
  expanded: boolean
  onToggle: () => void
  onStop?: () => void
}

function AgentRow({ entry, expanded, onToggle, onStop }: AgentRowProps) {
  const { label, icon } = entryIdentity(entry)
  const running = entry.status === 'running'
  // Qué está haciendo ahora: el paso en curso, la última tool que informó el SDK o el último texto.
  const activity = running
    ? (entry.currentStep ? getToolHumanLabel(entry.currentStep.name) : entry.lastToolName ? getToolHumanLabel(entry.lastToolName) : null)
    : null
  const meta = [entry.stepCount > 0 ? stepCountLabel(entry.stepCount) : null, activity].filter(Boolean).join(' · ')

  return (
    <div>
      {/* `role="button"` en un div (como en la barra de conversaciones): los pasos
          desplegados tienen sus propios botones y van FUERA de la fila. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={`w-full text-left px-2.5 py-2 rounded-lg transition-all duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
          expanded ? 'bg-white shadow-sm border border-sidebar-border' : 'hover:bg-white/70 border border-transparent'
        }`}
      >
        <div className="flex items-start gap-2">
          <AgentIconGlyph icon={icon} className={`size-3.5 mt-0.5 shrink-0 ${running ? 'text-brand-orange' : 'text-slate-500'}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {expanded
                ? <ChevronDown className="size-3 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
                : <ChevronRight className="size-3 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />}
              <p className={`text-xs font-medium truncate flex-1 ${entry.status === 'error' ? 'text-error' : running ? 'text-brand-orange' : 'text-brand-black'}`}>
                {label}
              </p>
              <EntryStatus entry={entry} />
            </div>
            {entry.task && (
              <p className="mt-0.5 text-[11px] text-slate-600 truncate" title={entry.fullTask || entry.task}>
                {entry.task}
              </p>
            )}
            {meta && <p className="mt-0.5 text-[10px] text-slate-400 truncate">{meta}</p>}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="ml-5 mt-1 mb-1.5 border-l border-slate-200 pl-2.5 space-y-0.5 text-xs">
          {entry.steps.map((step, i) => (
            <SubagentStepRow key={step.toolUseId ?? `${step.name}-${i}`} step={step} onStop={running ? onStop : undefined} />
          ))}
          {entry.lastText && (
            <p className="text-[10px] text-slate-400 italic line-clamp-3 pt-0.5" title={entry.lastText}>
              {entry.lastText}
            </p>
          )}
          {entry.steps.length === 0 && !entry.lastText && (
            <p className="text-[10px] text-slate-400 py-0.5">
              {running ? 'Todavía sin pasos' : 'Sin pasos registrados'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <span className="block pl-1 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-slate-500">{children}</span>
}

interface AgentsPanelProps {
  /** Runtime de la conversación visible (o '__default__' en la pantalla nueva). */
  conversationId: string
  open: boolean
  /** Ventana angosta: el panel se superpone al chat en vez de achicarlo. */
  overlay: boolean
  onClose: () => void
  /** La conversación delegó por primera vez (el padre decide si abrir el panel). */
  onFirstDelegation: (conversationId: string) => void
}

/**
 * Panel lateral «Agentes» (a la derecha del chat): los agentes que lanzó el orquestador
 * en esta conversación, qué tarea tiene cada uno y su estado. Sin agentes no se muestra
 * ni ocupa espacio. Las filas salen de stores/agentsPanel.ts.
 */
export function AgentsPanel({ conversationId, open, overlay, onClose, onFirstDelegation }: AgentsPanelProps) {
  const entries = useConversationAgents(conversationId)
  const runningCount = countRunningEntries(entries)
  // El padre lo monta con key = conversación: al cambiar de conversación no arrastra las
  // filas desplegadas de la otra.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())

  // Solo las delegaciones y los Workflows abren el panel: un comando en segundo plano no.
  const delegating = entries.some((e) => e.status === 'running' && (e.kind === 'agent' || e.kind === 'workflow'))
  useEffect(() => {
    if (!delegating || conversationId === '__default__' || autoOpened.has(conversationId)) return
    autoOpened.add(conversationId)
    onFirstDelegation(conversationId)
  }, [delegating, conversationId, onFirstDelegation])

  if (!open || entries.length === 0) return null

  const toggle = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // El mismo Detener del chat (solo en las filas en curso, que implican un turno vivo).
  const onStop = (): void => {
    const rt = getRuntime(conversationId)
    if (rt.isStreaming || rt.isPending) void storeAbort(conversationId)
  }

  const running = entries.filter((e) => e.status === 'running')
  const finished = entries.filter((e) => e.status !== 'running')

  return (
    <aside
      aria-label="Agentes"
      className={`border-l border-zinc-300 bg-[#f5f5f6] flex flex-col shrink-0 ${overlay ? 'absolute inset-y-0 right-0 z-30 shadow-xl' : ''}`}
      style={{ width: PANEL_WIDTH }}
    >
      <div className="flex items-center justify-between gap-2 pl-4 pr-3 pt-4 pb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-slate-500">AGENTES</span>
          <span className={`text-[11px] ${runningCount > 0 ? 'text-brand-orange font-medium' : 'text-slate-400'}`}>
            {runningCount > 0 ? `${runningCount} en curso` : `${entries.length} en total`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-500 transition-colors hover:bg-black/5"
          title="Ocultar agentes"
          aria-label="Ocultar agentes"
        >
          <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto cerp-scroll px-3 pb-4 space-y-0.5">
        {running.length > 0 && finished.length > 0 && <SectionLabel>EN CURSO</SectionLabel>}
        {running.map((entry) => (
          <AgentRow key={entry.id} entry={entry} expanded={expandedIds.has(entry.id)} onToggle={() => toggle(entry.id)} onStop={onStop} />
        ))}
        {running.length > 0 && finished.length > 0 && <SectionLabel>TERMINADOS</SectionLabel>}
        {finished.map((entry) => (
          <AgentRow key={entry.id} entry={entry} expanded={expandedIds.has(entry.id)} onToggle={() => toggle(entry.id)} />
        ))}
      </div>
    </aside>
  )
}

interface AgentsPanelToggleProps {
  conversationId: string
  open: boolean
  onToggle: () => void
}

/** Botón del encabezado que abre/cierra el panel, con la cantidad de agentes en curso. Sin agentes no se muestra. */
export function AgentsPanelToggle({ conversationId, open, onToggle }: AgentsPanelToggleProps) {
  const entries = useConversationAgents(conversationId)
  if (entries.length === 0) return null
  const runningCount = countRunningEntries(entries)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title={open ? 'Ocultar agentes' : 'Ver agentes'}
      className={`inline-flex h-[30px] items-center gap-1.5 rounded-full border border-composer-border px-3 text-xs font-medium text-[#3f3f46] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${open ? 'bg-black/5' : 'bg-white'}`}
    >
      <PanelRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
      Agentes
      {runningCount > 0 && (
        <span
          className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-brand-orange px-1 text-[10px] font-semibold text-white"
          aria-label={`${runningCount} en curso`}
        >
          {runningCount}
        </span>
      )}
    </button>
  )
}
