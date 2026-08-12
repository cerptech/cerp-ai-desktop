import type { AgentStreamEvent, AskUserQuestionItem, UserAnswerPayload, ModelChoice } from '../../../preload/index'
import type { ChatMessage, ToolExecution, SubagentStep, AgentDelegation } from '../hooks/useAgent'

/**
 * agentRuntimeStore — estado de streaming POR conversación.
 *
 * El main mantiene una sesión del SDK por conversationId y etiqueta cada evento
 * IPC con ese id. Este store mantiene un "runtime" por conversación y rutea cada
 * evento al suyo, de modo que una conversación de fondo sigue acumulando su
 * respuesta aunque el usuario esté mirando otra. Reemplaza al estado único que
 * vivía en useAgent (que mataba la conversación activa al cambiar de pestaña).
 *
 * El reducer (applyEvent) es un PORT FIEL del switch que estaba en useAgent:
 * preserva los fixes ya horneados (Bug #2 stream_start, Bug #4 waitingAfterAnswer,
 * suspensión de ask_user_question, ruteo de subagentes por parentToolUseId).
 *
 * La persistencia (appendConversationMessage) vive acá para cubrir también a las
 * conversaciones de fondo; dedup por (timestamp:role) por runtime.
 */

export interface ConversationRuntime {
  messages: ChatMessage[]
  isStreaming: boolean
  isPending: boolean
  activeTool: string | null
  error: string | null
  /** Distinguishes specific error causes (e.g. 'NO_CREDITS') so the UI can react differently. */
  errorCode: string | null
  activeAgentDelegation: AgentDelegation | null
  promptSuggestions: string[]
  statusMessage: string | null
  sessionCost: number
  sessionTokensIn: number
  sessionTokensOut: number
  pendingQuestions: AskUserQuestionItem[] | null
  isSubmittingAnswers: boolean
  // Antes eran refs en useAgent — ahora campos del runtime inmutable.
  tools: ToolExecution[]
  lastEvent: number
  currentDelegation: string | null
  needsNewAssistant: boolean
  waitingAfterAnswer: boolean
}

const EMPTY_RUNTIME: ConversationRuntime = Object.freeze({
  messages: [],
  isStreaming: false,
  isPending: false,
  activeTool: null,
  error: null,
  errorCode: null,
  activeAgentDelegation: null,
  promptSuggestions: [],
  statusMessage: null,
  sessionCost: 0,
  sessionTokensIn: 0,
  sessionTokensOut: 0,
  pendingQuestions: null,
  isSubmittingAnswers: false,
  tools: [],
  lastEvent: 0,
  currentDelegation: null,
  needsNewAssistant: false,
  waitingAfterAnswer: false,
})

function freshRuntime(): ConversationRuntime {
  return { ...EMPTY_RUNTIME, messages: [], tools: [], promptSuggestions: [] }
}

// ── Store internals ─────────────────────────────────────────────────────────

const runtimes = new Map<string, ConversationRuntime>()
const listeners = new Map<string, Set<() => void>>()
// Persistencia: claves ya guardadas por conversación (timestamp:role).
const persistedKeys = new Map<string, Set<string>>()
// Callback opcional para crear/registrar persistencia — set por el provider.
let persistFn: ((conversationId: string, message: ChatMessage) => void) | null = null

const msgKey = (m: ChatMessage): string => `${m.timestamp}:${m.role}`

function getListeners(conversationId: string): Set<() => void> {
  let s = listeners.get(conversationId)
  if (!s) { s = new Set(); listeners.set(conversationId, s) }
  return s
}

function notify(conversationId: string): void {
  const s = listeners.get(conversationId)
  if (s) for (const cb of s) cb()
}

/** Snapshot estable para useSyncExternalStore. */
export function getRuntime(conversationId: string): ConversationRuntime {
  return runtimes.get(conversationId) ?? EMPTY_RUNTIME
}

export function subscribe(conversationId: string, cb: () => void): () => void {
  const s = getListeners(conversationId)
  s.add(cb)
  return () => { s.delete(cb) }
}

/** Aplica una mutación inmutable al runtime de una conversación y notifica. */
function update(conversationId: string, fn: (rt: ConversationRuntime) => ConversationRuntime): void {
  const current = runtimes.get(conversationId) ?? freshRuntime()
  const next = fn(current)
  runtimes.set(conversationId, next)
  notify(conversationId)
}

// ── Persistencia ──────────────────────────────────────────────────────────

export function setPersistHandler(fn: ((conversationId: string, message: ChatMessage) => void) | null): void {
  persistFn = fn
}

/** Marca como ya persistidos los mensajes de una conversación restaurada de la DB. */
export function seedPersisted(conversationId: string, messages: ChatMessage[]): void {
  persistedKeys.set(conversationId, new Set(messages.map(msgKey)))
}

function persistNewMessages(conversationId: string, rt: ConversationRuntime): void {
  if (!persistFn || conversationId === '__default__') return
  let seen = persistedKeys.get(conversationId)
  if (!seen) { seen = new Set(); persistedKeys.set(conversationId, seen) }
  for (const msg of rt.messages) {
    const key = msgKey(msg)
    if (seen.has(key)) continue
    if (msg.role === 'user') {
      seen.add(key)
      persistFn(conversationId, msg)
    } else if (msg.role === 'assistant' && !rt.isStreaming && (msg.content?.trim() || msg.tools?.length)) {
      // Igual que en ChatContainer: el assistant se persiste cuando el turno terminó.
      seen.add(key)
      persistFn(conversationId, msg)
    }
  }
}

// ── Reducer (port fiel del switch de useAgent) ───────────────────────────────

function updateLastAssistant(
  messages: ChatMessage[],
  currentDelegation: string | null,
  updater: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    return [...messages.slice(0, -1), updater(last)]
  }
  const newMsg: ChatMessage = {
    role: 'assistant',
    content: '',
    tools: [],
    timestamp: Date.now(),
    agentContext: currentDelegation || undefined,
  }
  return [...messages, updater(newMsg)]
}

function applyEvent(rt: ConversationRuntime, event: AgentStreamEvent): ConversationRuntime {
  const now = Date.now()

  // Bug #2: stream_start es señal pura — prende isStreaming/isPending, nada más.
  if (event.type === 'stream_start') {
    return { ...rt, isStreaming: true, isPending: false, lastEvent: now }
  }

  // Primer evento real: limpiar pending + el gate de waitingAfterAnswer (Bug #4, línea 173 del hook).
  let r: ConversationRuntime = { ...rt, lastEvent: now, isPending: false, waitingAfterAnswer: false }

  switch (event.type) {
    // Delta de streaming (Ola 2) — SE ACUMULA (append), a diferencia de 'text'
    // que reemplaza. Cuando llega el bloque completo ('text', más abajo) se
    // reconcilia reemplazando el contenido acumulado por el texto autoritativo
    // del SDK, evitando drift entre los deltas y la versión final.
    case 'text_delta': {
      if (r.needsNewAssistant) {
        return {
          ...r,
          needsNewAssistant: false,
          tools: [],
          messages: [...r.messages, {
            role: 'assistant',
            content: event.text,
            timestamp: now,
            tools: [],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({
          ...msg,
          content: (msg.content || '') + event.text,
          tools: [...r.tools],
          agentContext: r.currentDelegation || msg.agentContext,
        })),
      }
    }
    case 'text': {
      if (r.needsNewAssistant) {
        return {
          ...r,
          needsNewAssistant: false,
          tools: [],
          messages: [...r.messages, {
            role: 'assistant',
            content: event.text,
            timestamp: now,
            tools: [],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        // Reconciliación: el bloque completo del SDK reemplaza (no acumula) lo
        // que hayan ido armando los `text_delta` previos — es la versión
        // autoritativa, así que gana ella si hay cualquier diferencia.
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({
          ...msg,
          content: event.text,
          tools: [...r.tools],
          agentContext: r.currentDelegation || msg.agentContext,
        })),
      }
    }
    case 'tool_start': {
      const isAgentTool = event.name === 'Agent' || event.name === 'Task'
      const tool: ToolExecution = {
        name: event.name,
        input: event.input,
        status: 'running',
        timestamp: now,
        startTime: now,
        toolUseId: event.toolUseId,
        ...(isAgentTool ? { subagentSteps: [] } : {}),
      }
      const tools = [...r.tools, tool]
      return {
        ...r,
        tools,
        activeTool: event.name,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })),
      }
    }
    case 'tool_done': {
      const doneTool = r.tools.find((t) => t.toolUseId === event.toolUseId)
      const isAgentTool = doneTool?.name === 'Agent' || doneTool?.name === 'Task'
      const tools = r.tools.map((t) =>
        t.toolUseId === event.toolUseId && t.status === 'running'
          ? {
              ...t,
              status: (event.isError ? 'error' : 'done') as ToolExecution['status'],
              output: event.output,
              endTime: now,
              ...(t.subagentSteps
                ? { subagentSteps: t.subagentSteps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const, endTime: now } : s)) }
                : {}),
            }
          : t,
      )
      const stillRunning = tools.find((t) => t.status === 'running')
      return {
        ...r,
        tools,
        activeTool: stillRunning?.name || null,
        currentDelegation: isAgentTool ? null : r.currentDelegation,
        activeAgentDelegation: isAgentTool ? null : r.activeAgentDelegation,
        messages: updateLastAssistant(r.messages, isAgentTool ? null : r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })),
      }
    }
    case 'agent_delegation': {
      const d = event
      const tools = r.tools.map((t) => (t.toolUseId === d.toolUseId ? { ...t, agentName: d.agentName } : t))
      return {
        ...r,
        currentDelegation: d.agentName,
        activeAgentDelegation: { agentName: d.agentName, task: d.task },
        tools,
        messages: updateLastAssistant(r.messages, d.agentName, (msg) => ({ ...msg, tools: [...tools] })),
      }
    }
    case 'subagent_tool_start': {
      const ev = event
      const newStep: SubagentStep = { toolUseId: ev.toolUseId, name: ev.name, input: ev.input, status: 'running', startTime: now }
      const tools = r.tools.map((t) =>
        t.toolUseId === ev.parentToolUseId ? { ...t, subagentSteps: [...(t.subagentSteps ?? []), newStep] } : t,
      )
      return { ...r, tools, messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })) }
    }
    case 'subagent_tool_done': {
      const ev = event
      const tools = r.tools.map((t) => {
        if (t.toolUseId !== ev.parentToolUseId || !t.subagentSteps) return t
        return {
          ...t,
          subagentSteps: t.subagentSteps.map((s) =>
            s.toolUseId === ev.toolUseId && s.status === 'running'
              ? { ...s, status: (ev.isError ? 'error' : 'done') as SubagentStep['status'], output: ev.output, endTime: now }
              : s,
          ),
        }
      })
      return { ...r, tools, messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })) }
    }
    case 'subagent_text': {
      const ev = event
      const tools = r.tools.map((t) => (t.toolUseId === ev.parentToolUseId ? { ...t, subagentText: ev.text } : t))
      return { ...r, tools, messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })) }
    }
    case 'prompt_suggestions': {
      return { ...r, promptSuggestions: event.suggestions }
    }
    case 'status': {
      return event.message ? { ...r, statusMessage: event.message } : r
    }
    case 'done': {
      const d = event
      return {
        ...r,
        sessionCost: r.sessionCost + (d.cost ?? 0),
        sessionTokensIn: r.sessionTokensIn + (d.tokensIn ?? 0),
        sessionTokensOut: r.sessionTokensOut + (d.tokensOut ?? 0),
        isStreaming: false,
        isPending: false,
        statusMessage: null,
        activeTool: null,
        activeAgentDelegation: null,
        currentDelegation: null,
      }
    }
    case 'error': {
      const tools = r.tools.map((t) => (t.status === 'running' ? { ...t, status: 'error' as const, endTime: now } : t))
      return {
        ...r,
        error: event.message,
        errorCode: event.code ?? null,
        isStreaming: false,
        isPending: false,
        activeTool: null,
        activeAgentDelegation: null,
        currentDelegation: null,
        tools,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...tools] })),
      }
    }
    default:
      return r
  }
}

// ── Manejo de eventos done / ask_user_question ───────────────────────────────

function handleDone(conversationId: string): void {
  update(conversationId, (rt) => {
    // Bug #4: si el usuario acaba de responder ask_user_question y el agente aún
    // no emitió nada, un done viejo no debe resetear isStreaming/isPending.
    if (rt.waitingAfterAnswer) return rt
    const now = Date.now()
    const tools = rt.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const, endTime: now } : t))
    const messages = (() => {
      const last = rt.messages[rt.messages.length - 1]
      if (last?.role === 'assistant' && tools.length > 0) {
        return [...rt.messages.slice(0, -1), { ...last, tools: [...tools] }]
      }
      return rt.messages
    })()
    return { ...rt, isStreaming: false, isPending: false, activeTool: null, activeAgentDelegation: null, currentDelegation: null, tools, messages }
  })
  persistNewMessages(conversationId, getRuntime(conversationId))
}

// ── Suscripción IPC única (se monta una sola vez) ────────────────────────────

let ipcWired = false

function ensureIpcWired(): void {
  if (ipcWired) return
  ipcWired = true

  window.cerpAPI.onAgentMessage((event, conversationId) => {
    const id = conversationId || '__default__'
    update(id, (rt) => applyEvent(rt, event))
    // Persistir cuando el turno cierra con un evento done dentro del stream.
    if (event.type === 'done') persistNewMessages(id, getRuntime(id))
  })

  window.cerpAPI.onAgentDone((conversationId) => {
    handleDone(conversationId || '__default__')
  })

  window.cerpAPI.onAgentError((err, conversationId) => {
    const id = conversationId || '__default__'
    update(id, (rt) => ({
      ...rt,
      error: err.message,
      errorCode: err.code ?? null,
      isStreaming: false,
      isPending: false,
      activeTool: null,
      activeAgentDelegation: null,
      currentDelegation: null,
    }))
  })

  window.cerpAPI.onAskUserQuestion((questions, conversationId) => {
    const id = conversationId || '__default__'
    // El agente arranca un turno NUEVO al recibir la respuesta → marcar que el
    // próximo text debe ser un mensaje assistant nuevo (no pisar el contexto previo).
    update(id, (rt) => ({ ...rt, pendingQuestions: questions, needsNewAssistant: true }))
  })

  // Timer de inactividad (fallback): 60s sin eventos con isStreaming = stall real.
  // El heartbeat del main (cada 5s mientras procesa) evita que se dispare en pausas legítimas.
  setInterval(() => {
    const now = Date.now()
    for (const [id, rt] of runtimes) {
      if (rt.isStreaming && now - rt.lastEvent > 60_000) {
        update(id, (r) => {
          const tools = r.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const, endTime: now } : t))
          const last = r.messages[r.messages.length - 1]
          const messages = last?.role === 'assistant' && tools.length > 0
            ? [...r.messages.slice(0, -1), { ...last, tools: [...tools] }]
            : r.messages
          return { ...r, isStreaming: false, activeTool: null, activeAgentDelegation: null, currentDelegation: null, tools, messages }
        })
      }
    }
  }, 5_000)
}

// ── API pública de acciones ──────────────────────────────────────────────────

export async function sendPrompt(
  conversationId: string,
  prompt: string,
  cwd?: string,
  activeContextId?: string,
  modelChoice?: ModelChoice,
): Promise<void> {
  ensureIpcWired()
  // Snapshot del historial ANTES de agregar el mensaje del usuario (igual que useAgent).
  const prevMessages = getRuntime(conversationId).messages
  const history = prevMessages.map((m) => ({ role: m.role, content: m.content }))

  update(conversationId, (rt) => ({
    ...rt,
    error: null,
    errorCode: null,
    isStreaming: true,
    isPending: true,
    activeTool: null,
    activeAgentDelegation: null,
    promptSuggestions: [],
    statusMessage: null,
    currentDelegation: null,
    waitingAfterAnswer: false,
    tools: [],
    messages: [...rt.messages, { role: 'user', content: prompt, timestamp: Date.now() }],
  }))
  // Persistir el mensaje del usuario inmediatamente.
  persistNewMessages(conversationId, getRuntime(conversationId))

  const result = await window.cerpAPI.sendPrompt({ prompt, conversationId, cwd, activeContextId, conversationHistory: history, modelChoice })
  if (!result.started) {
    update(conversationId, (rt) => ({
      ...rt,
      error: result.error || 'No se pudo iniciar la consulta',
      errorCode: result.code ?? null,
      isStreaming: false,
      isPending: false,
    }))
  }
}

export async function abort(conversationId: string): Promise<void> {
  await window.cerpAPI.abortAgent(conversationId)
  update(conversationId, (rt) => ({
    ...rt,
    isStreaming: false,
    isPending: false,
    activeTool: null,
    activeAgentDelegation: null,
    pendingQuestions: null,
    isSubmittingAnswers: false,
    needsNewAssistant: false,
    waitingAfterAnswer: false,
    currentDelegation: null,
  }))
}

export async function submitAnswers(
  conversationId: string,
  pendingQuestions: AskUserQuestionItem[],
  answers: UserAnswerPayload,
): Promise<void> {
  // Eco de las respuestas como mensaje de usuario (audit trail), igual que useAgent.
  const echoLines = pendingQuestions.map((q) => {
    const ans = answers[q.question]
    const ansText = Array.isArray(ans) ? ans.join(', ') : (ans ?? '(sin respuesta)')
    return `- **${q.header}**: ${ansText}`
  }).join('\n')
  const echoContent = pendingQuestions.length === 1
    ? `Respuesta: ${echoLines.replace(/^- \*\*[^*]+\*\*: /, '')}`
    : `Respondí:\n${echoLines}`

  update(conversationId, (rt) => ({
    ...rt,
    messages: [...rt.messages, { role: 'user', content: echoContent, timestamp: Date.now() }],
    isSubmittingAnswers: true,
    waitingAfterAnswer: true,
    isPending: true,
    isStreaming: true,
  }))
  persistNewMessages(conversationId, getRuntime(conversationId))

  try {
    await window.cerpAPI.submitUserAnswers(conversationId, answers)
    update(conversationId, (rt) => ({ ...rt, pendingQuestions: null }))
  } finally {
    update(conversationId, (rt) => ({ ...rt, isSubmittingAnswers: false }))
  }
}

/** Restaura mensajes de una conversación cargada de la DB (no re-persistir). */
export function restoreMessages(conversationId: string, messages: ChatMessage[]): void {
  ensureIpcWired()
  seedPersisted(conversationId, messages)
  update(conversationId, () => ({ ...freshRuntime(), messages }))
}

/** Limpia el runtime de una conversación (al borrarla, p.ej.). */
export function clearRuntime(conversationId: string): void {
  runtimes.delete(conversationId)
  persistedKeys.delete(conversationId)
  notify(conversationId)
}

export { ensureIpcWired }
