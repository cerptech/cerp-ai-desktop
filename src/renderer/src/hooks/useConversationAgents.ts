import { useCallback, useRef, useSyncExternalStore } from 'react'
import { getRuntime, subscribe, ensureIpcWired } from '../stores/agentRuntimeStore'
import { agentEntrySources, deriveAgentEntries, type AgentEntry } from '../stores/agentsPanel'

interface Snapshot {
  sources: unknown[]
  entries: AgentEntry[]
}

const EMPTY: Snapshot = { sources: [], entries: [] }

function sameSources(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Filas del panel de agentes de UNA conversación (ver stores/agentsPanel.ts).
 *
 * Devuelve la MISMA referencia mientras no cambie ninguna delegación ni tarea: el texto
 * del orquestador llega token a token y notifica el runtime en cada delta, y sin esto el
 * panel y el botón del encabezado se re-renderizaban con cada token.
 */
export function useConversationAgents(conversationId: string): AgentEntry[] {
  ensureIpcWired()
  const cache = useRef<{ id: string; snap: Snapshot }>({ id: conversationId, snap: EMPTY })

  const getSnapshot = useCallback((): AgentEntry[] => {
    const rt = getRuntime(conversationId)
    const sources = agentEntrySources(rt.messages, rt.backgroundTasks)
    const prev = cache.current
    if (prev.id === conversationId && sameSources(prev.snap.sources, sources)) return prev.snap.entries
    const snap = { sources, entries: deriveAgentEntries(rt.messages, rt.backgroundTasks) }
    cache.current = { id: conversationId, snap }
    return snap.entries
  }, [conversationId])

  const sub = useCallback((cb: () => void) => subscribe(conversationId, cb), [conversationId])
  return useSyncExternalStore(sub, getSnapshot)
}
