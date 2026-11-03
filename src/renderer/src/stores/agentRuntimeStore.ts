import type { AgentStreamEvent, AskUserQuestionItem, UserAnswerPayload, ModelChoice } from '../../../preload/index'
import type { ChatMessage, ToolExecution, SubagentStep, AgentDelegation, BackgroundTask } from '../hooks/useAgent'
import { GENERIC_RETRY_PROMPT } from '../utils/retryPrompt'
import { interruptRunningSteps, interruptRunningTasks, taskStatusFromSdk } from './stepLifecycle'

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
  /**
   * El turno se cortó por un fallo (RQM-166): prompt que manda "Reintentar" para
   * retomar donde quedó. null = el error no se resuelve reintentando.
   */
  retryPrompt: string | null
  activeAgentDelegation: AgentDelegation | null
  promptSuggestions: string[]
  statusMessage: string | null
  /**
   * Cuánto hace que el SDK no manda ningún mensaje, según el último heartbeat del main
   * (`Date.now() - lastActivityAt`). 0 = hay actividad. Lo muestra el loader («Sin
   * actividad hace N min») para que nadie espere a ciegas los 15 min del watchdog.
   */
  sdkIdleMs: number
  /**
   * El usuario pulsó Detener y el main todavía no cerró el turno: los heartbeats que
   * siguen llegando hasta el `result` abortado no vuelven a prender el loader.
   */
  stopRequested: boolean
  sessionCost: number
  sessionTokensIn: number
  sessionTokensOut: number
  pendingQuestions: AskUserQuestionItem[] | null
  isSubmittingAnswers: boolean
  // Antes eran refs en useAgent — ahora campos del runtime inmutable.
  tools: ToolExecution[]
  /**
   * Tareas de fondo del SDK de TODA la sesión de la app en esta conversación (no solo
   * del turno: a diferencia de `tools`, no se vacía al enviar). Las lee el panel de
   * agentes; al cerrarse un turno, las que siguen abiertas quedan 'interrupted'.
   */
  backgroundTasks: BackgroundTask[]
  lastEvent: number
  currentDelegation: string | null
  needsNewAssistant: boolean
  waitingAfterAnswer: boolean
  /**
   * Acumulador de texto del turno EN CURSO, indexado por content block (ver
   * `textAccumulator` más abajo para el detalle del bug que esto arregla).
   */
  textAccumulator: TextAccumulator
  /**
   * Carpeta de trabajo de ESTA conversación. Antes vivía como estado único en
   * ChatContainer, así que la última carpeta elegida se aplicaba a TODAS las
   * conversaciones (el cliente con 3 licitaciones en 3 conversaciones veía las
   * tres apuntando a la última carpeta). Se persiste en metadata.cwd de la
   * conversación y se restaura al reabrirla.
   */
  cwd: string | null
}

/**
 * `text_delta` llega token a token con el `index` del content block del SDK al que
 * pertenece (ver agentManager.ts:864). Un turno puede tener VARIOS bloques de texto
 * si el modelo hace una tool call en el medio (bloque 0: texto antes de la tool,
 * bloque 2 p.ej.: texto después). Antes, `text_delta` simplemente hacía
 * `content + event.text` sin mirar el índice — así que los deltas del segundo
 * bloque se seguían pegando al final del primero, lo cual por sí solo no rompía
 * nada. El bug real estaba en `text` (el evento autoritativo que cierra un bloque):
 * `block.text` en agentManager.ts (línea ~875) es el texto COMPLETO de ESE bloque
 * únicamente, no de todo el mensaje — pero el reducer hacía `content: event.text`,
 * o sea REEMPLAZABA todo el contenido acumulado (bloque 0 + bloque 1...) por el
 * texto del último bloque solo. Resultado visible: el texto crece con los deltas
 * y de golpe "pega un salto atrás" perdiendo el contenido de los bloques previos
 * en cuanto llega el `text` autoritativo del bloque siguiente.
 *
 * Fix: `committed` guarda el texto YA CERRADO por bloques anteriores (se le suma
 * el texto autoritativo de cada `text` que llega). `buffer` acumula los deltas del
 * bloque ABIERTO actual. Si `text_delta` llega con un `index` distinto al bloque
 * que se venía llenando, el buffer viejo se pliega a `committed` (por si el turno
 * termina o aborta sin que llegue un `text` autoritativo para ese bloque — no se
 * pierde lo ya tipeado). El contenido mostrado siempre es `committed + buffer`.
 */
interface TextAccumulator {
  blockIndex: number | null
  committed: string
  buffer: string
}

const EMPTY_TEXT_ACCUMULATOR: TextAccumulator = Object.freeze({ blockIndex: null, committed: '', buffer: '' })

const EMPTY_RUNTIME: ConversationRuntime = Object.freeze({
  messages: [],
  isStreaming: false,
  isPending: false,
  activeTool: null,
  error: null,
  errorCode: null,
  retryPrompt: null,
  activeAgentDelegation: null,
  promptSuggestions: [],
  statusMessage: null,
  sdkIdleMs: 0,
  stopRequested: false,
  sessionCost: 0,
  sessionTokensIn: 0,
  sessionTokensOut: 0,
  pendingQuestions: null,
  isSubmittingAnswers: false,
  tools: [],
  backgroundTasks: [],
  lastEvent: 0,
  currentDelegation: null,
  needsNewAssistant: false,
  waitingAfterAnswer: false,
  textAccumulator: EMPTY_TEXT_ACCUMULATOR,
  cwd: null,
})

function freshRuntime(): ConversationRuntime {
  return { ...EMPTY_RUNTIME, messages: [], tools: [], backgroundTasks: [], promptSuggestions: [], textAccumulator: EMPTY_TEXT_ACCUMULATOR }
}

// ── Store internals ─────────────────────────────────────────────────────────

const runtimes = new Map<string, ConversationRuntime>()
const listeners = new Map<string, Set<() => void>>()
// Suscriptores GLOBALES (todas las conversaciones) — usados por el indicador de
// actividad del sidebar, que necesita saber qué conversaciones de FONDO están
// trabajando sin suscribirse al runtime completo de cada una (ver notifyGlobal).
const globalListeners = new Set<() => void>()
// Persistencia: claves ya guardadas por conversación (timestamp:role).
const persistedKeys = new Map<string, Set<string>>()
// Callback opcional para crear/registrar persistencia — set por el provider.
// metadata viaja junto con el mensaje de usuario (hoy: cwd de la conversación,
// que el server mergea en metadata.cwd — ver desktopConversationController).
let persistFn: ((conversationId: string, message: ChatMessage, metadata?: { cwd?: string | null }) => void) | null = null

const msgKey = (m: ChatMessage): string => `${m.timestamp}:${m.role}`

function getListeners(conversationId: string): Set<() => void> {
  let s = listeners.get(conversationId)
  if (!s) { s = new Set(); listeners.set(conversationId, s) }
  return s
}

function notify(conversationId: string): void {
  const s = listeners.get(conversationId)
  if (s) for (const cb of s) cb()
  notifyGlobal()
}

function notifyGlobal(): void {
  for (const cb of globalListeners) cb()
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

/** Se dispara en CUALQUIER cambio de CUALQUIER conversación (incluidas las de fondo). */
export function subscribeGlobal(cb: () => void): () => void {
  globalListeners.add(cb)
  return () => { globalListeners.delete(cb) }
}

// Cache del último snapshot de ids activos — getActiveConversationIds() devuelve
// SIEMPRE la misma referencia de Set mientras el conjunto de ids no cambie, para
// que useSyncExternalStore no dispare un re-render en cada tick de streaming
// (que notifica el store pero no cambia QUIÉN está activo).
let activeIdsCacheKey = ''
let activeIdsCache: Set<string> = new Set()

/** Ids de conversación con `isStreaming || isPending` en true ahora mismo. */
export function getActiveConversationIds(): Set<string> {
  const ids: string[] = []
  for (const [id, rt] of runtimes) {
    if (rt.isStreaming || rt.isPending) ids.push(id)
  }
  ids.sort()
  const key = ids.join(',')
  if (key !== activeIdsCacheKey) {
    activeIdsCacheKey = key
    activeIdsCache = new Set(ids)
  }
  return activeIdsCache
}

/** Aplica una mutación inmutable al runtime de una conversación y notifica. */
function update(conversationId: string, fn: (rt: ConversationRuntime) => ConversationRuntime): void {
  const current = runtimes.get(conversationId) ?? freshRuntime()
  const next = fn(current)
  runtimes.set(conversationId, next)
  notify(conversationId)
}

// ── Persistencia ──────────────────────────────────────────────────────────

export function setPersistHandler(fn: ((conversationId: string, message: ChatMessage, metadata?: { cwd?: string | null }) => void) | null): void {
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
      // La carpeta de trabajo viaja con cada mensaje de usuario: el server hace
      // $set de metadata.cwd (aditivo, no toca los mensajes), y al reabrir la
      // conversación se restaura la carpeta que tenía.
      persistFn(conversationId, msg, { cwd: rt.cwd })
    } else if (msg.role === 'assistant' && !rt.isStreaming && (msg.content?.trim() || msg.tools?.length)) {
      // Igual que en ChatContainer: el assistant se persiste cuando el turno terminó.
      seen.add(key)
      persistFn(conversationId, msg)
    }
  }
}

// ── Reducer (port fiel del switch de useAgent) ───────────────────────────────

/**
 * Cierra el turno en el runtime: lo que quedó "running" (tools y pasos de subagente,
 * en TODAS las burbujas del turno) pasa a 'interrupted'. Es el único camino de cierre:
 * lo usan done (evento y canal), error, Detener, el stall timer y el envío de un prompt
 * nuevo. Antes cada camino cerraba distinto — 'done' (un paso sin resultado con check
 * verde), 'error' (un Bash que ni llegó a ejecutarse, como error) o nada (Detener
 * esperaba al main) — y un paso cuyo resultado nunca llegó podía quedar girando con un
 * contador de horas (RQM-166; el Bash de 921 min de Facundo en v1.0.40).
 */
function interruptOpenSteps(rt: ConversationRuntime, now: number): ConversationRuntime {
  // Las tareas de fondo también: el panel de agentes no puede dejar a nadie «trabajando»
  // con el turno cerrado (el main retiene el `done` mientras quedan tareas vivas, así
  // que si el turno cierra con una abierta, esa tarea ya no la sigue nadie).
  const backgroundTasks = interruptRunningTasks(rt.backgroundTasks, now)
  const tools = interruptRunningSteps(rt.tools, now)
  if (tools === rt.tools && backgroundTasks === rt.backgroundTasks) return rt
  if (tools === rt.tools) return { ...rt, backgroundTasks }
  return { ...rt, tools, backgroundTasks, messages: syncToolsToBubbles(rt.messages, tools) }
}

/** Aplica `fn` a la tarea `taskId` (sin cambios si no existe). */
function updateTask(rt: ConversationRuntime, taskId: string, fn: (t: BackgroundTask) => BackgroundTask): ConversationRuntime {
  if (!rt.backgroundTasks.some((t) => t.taskId === taskId)) return rt
  return { ...rt, backgroundTasks: rt.backgroundTasks.map((t) => (t.taskId === taskId ? fn(t) : t)) }
}

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

const sameTool = (a: ToolExecution, b: ToolExecution): boolean =>
  a.toolUseId ? a.toolUseId === b.toolUseId : !b.toolUseId && a.name === b.name && a.startTime === b.startTime

/**
 * Copia el estado de `tools` (la lista del turno) a la burbuja que tiene cada tool.
 * Una pregunta respondida en medio del turno lo parte en dos burbujas (lo de antes y
 * lo de después de la respuesta), pero el turno sigue siendo UNO: la tool que
 * preguntó termina después de la respuesta y su resultado tiene que llegar a la
 * burbuja de antes. Antes cada evento copiaba la lista entera a la última burbuja:
 * la de después repetía los pasos de antes y la de antes quedaba girando para siempre.
 */
function syncToolsToBubbles(messages: ChatMessage[], tools: ToolExecution[]): ChatMessage[] {
  let changed = false
  const next = messages.map((m) => {
    if (m.role !== 'assistant' || !m.tools?.length) return m
    let touched = false
    const synced = m.tools.map((t) => {
      const fresh = tools.find((x) => sameTool(x, t))
      if (!fresh || fresh === t) return t
      touched = true
      return fresh
    })
    if (!touched) return m
    changed = true
    return { ...m, tools: synced }
  })
  return changed ? next : messages
}

function applyEvent(rt: ConversationRuntime, event: AgentStreamEvent): ConversationRuntime {
  const now = Date.now()

  // Bug #2: stream_start es señal pura — prende isStreaming/isPending, nada más.
  // También resetea el acumulador de texto por bloque: es el arranque de un turno
  // NUEVO (incluido el que sigue a un ask_user_question respondido), así que no debe
  // arrastrar el `committed`/`buffer` del turno anterior.
  if (event.type === 'stream_start') {
    return { ...rt, isStreaming: true, isPending: false, lastEvent: now, textAccumulator: EMPTY_TEXT_ACCUMULATOR }
  }

  // Latido del main (cada 5 s con un turno en curso): el agente sigue vivo. Como
  // stream_start, no limpia el gate de waitingAfterAnswer (Bug #4); a diferencia de
  // stream_start, NO resetea el acumulador de texto: llega en medio de un bloque.
  // Trae cuánto hace que el SDK no manda nada (`idleMs`). Tras Detener, los latidos que
  // llegan hasta el `result` abortado no vuelven a prender el loader.
  if (event.type === 'heartbeat') {
    const sdkIdleMs = event.idleMs ?? 0
    if (rt.stopRequested) return { ...rt, lastEvent: now, sdkIdleMs }
    return { ...rt, isStreaming: true, isPending: false, lastEvent: now, sdkIdleMs }
  }

  // Primer evento real: limpiar pending + el gate de waitingAfterAnswer (Bug #4, línea 173 del hook).
  // Cualquier evento que no es latido viene de un mensaje del SDK: hay actividad.
  let r: ConversationRuntime = { ...rt, lastEvent: now, isPending: false, waitingAfterAnswer: false, sdkIdleMs: 0 }

  switch (event.type) {
    // Delta de streaming (Ola 2) — bufferizado POR BLOQUE (ver TextAccumulator arriba).
    // Si el índice del bloque cambia respecto al que se venía llenando, el buffer
    // del bloque anterior se pliega a `committed` ANTES de empezar el nuevo — así
    // el segundo bloque de texto de un turno (p.ej. el que sigue a una tool call) no
    // se concatena por error al primero ni lo pisa.
    case 'text_delta': {
      const prevAcc = r.textAccumulator
      const isNewBlock = prevAcc.blockIndex !== null && prevAcc.blockIndex !== event.index
      const committed = isNewBlock ? prevAcc.committed + prevAcc.buffer : prevAcc.committed
      const buffer = (isNewBlock ? '' : prevAcc.buffer) + event.text
      const textAccumulator: TextAccumulator = { blockIndex: event.index, committed, buffer }
      const fullText = committed + buffer

      // `tools` NO se vacía al abrir la burbuja de después de una respuesta: es la
      // lista del turno, y la tool que preguntó todavía puede estar corriendo.
      if (r.needsNewAssistant) {
        return {
          ...r,
          needsNewAssistant: false,
          textAccumulator,
          messages: [...r.messages, {
            role: 'assistant',
            content: fullText,
            timestamp: now,
            tools: [],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        textAccumulator,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({
          ...msg,
          content: fullText,
          agentContext: r.currentDelegation || msg.agentContext,
        })),
      }
    }
    case 'text': {
      // Reconciliación: `event.text` es el texto COMPLETO y autoritativo del bloque
      // que se acaba de cerrar (no de todo el mensaje — ver comentario de
      // TextAccumulator). Se suma a `committed` (no reemplaza el mensaje entero) y
      // el buffer del bloque se vacía: si había drift entre los deltas y la versión
      // final del SDK, gana la autoritativa para ESE bloque, pero los bloques
      // previos ya cerrados en `committed` se preservan.
      const prevAcc = r.textAccumulator
      const committed = prevAcc.committed + event.text
      const textAccumulator: TextAccumulator = { blockIndex: prevAcc.blockIndex, committed, buffer: '' }

      if (r.needsNewAssistant) {
        return {
          ...r,
          needsNewAssistant: false,
          textAccumulator,
          messages: [...r.messages, {
            role: 'assistant',
            content: committed,
            timestamp: now,
            tools: [],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        textAccumulator,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({
          ...msg,
          content: committed,
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
      // Después de una respuesta, la primera tool abre la burbuja nueva (igual que
      // el texto): si no, los pasos y el texto de después quedaban en dos burbujas.
      if (r.needsNewAssistant) {
        return {
          ...r,
          tools,
          activeTool: event.name,
          needsNewAssistant: false,
          messages: [...r.messages, {
            role: 'assistant',
            content: '',
            timestamp: now,
            tools: [tool],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        tools,
        activeTool: event.name,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({ ...msg, tools: [...(msg.tools ?? []), tool] })),
      }
    }
    case 'tool_done': {
      const doneTool = r.tools.find((t) => t.toolUseId === event.toolUseId)
      const isAgentTool = doneTool?.name === 'Agent' || doneTool?.name === 'Task'
      // Un sub-paso sin resultado cuando su delegación ya volvió: si el subagente terminó
      // bien, el paso terminó (su resultado no se reenvió); si falló, quedó interrumpido.
      const orphanStepStatus: SubagentStep['status'] = event.isError ? 'interrupted' : 'done'
      const tools = r.tools.map((t) =>
        t.toolUseId === event.toolUseId && t.status === 'running'
          ? {
              ...t,
              status: (event.isError ? 'error' : 'done') as ToolExecution['status'],
              output: event.output,
              endTime: now,
              awaitingUser: undefined,
              ...(t.subagentSteps
                ? { subagentSteps: t.subagentSteps.map((s) => (s.status === 'running' ? { ...s, status: orphanStepStatus, endTime: now, awaitingUser: undefined } : s)) }
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
        messages: syncToolsToBubbles(r.messages, tools),
      }
    }
    case 'agent_delegation': {
      const d = event
      // La tarea viaja con la delegación para el panel de agentes. Sin nombre de
      // especialista (agente genérico) solo se guarda la tarea: el resto, como antes.
      const tools = r.tools.map((t) =>
        t.toolUseId === d.toolUseId
          ? { ...t, agentName: d.agentName || t.agentName, taskDescription: d.description, taskPrompt: d.task }
          : t,
      )
      if (!d.agentName) return { ...r, tools, messages: syncToolsToBubbles(r.messages, tools) }
      return {
        ...r,
        currentDelegation: d.agentName,
        activeAgentDelegation: { agentName: d.agentName, task: d.task },
        tools,
        messages: syncToolsToBubbles(r.messages, tools),
      }
    }
    // Tareas de fondo del SDK (panel de agentes). Se identifican por task_id: un
    // task_started repetido no duplica la fila.
    case 'task_started': {
      const ev = event
      if (r.backgroundTasks.some((t) => t.taskId === ev.taskId)) return r
      const task: BackgroundTask = {
        taskId: ev.taskId,
        toolUseId: ev.toolUseId,
        taskType: ev.taskType,
        description: ev.description,
        subagentType: ev.subagentType,
        workflowName: ev.workflowName,
        status: 'running',
        startTime: now,
      }
      return { ...r, backgroundTasks: [...r.backgroundTasks, task] }
    }
    case 'task_progress': {
      const ev = event
      return updateTask(r, ev.taskId, (t) => ({
        ...t,
        description: ev.description || t.description,
        lastToolName: ev.lastToolName ?? t.lastToolName,
        summary: ev.summary ?? t.summary,
        toolUses: ev.toolUses ?? t.toolUses,
      }))
    }
    case 'task_notification': {
      // El resultado real pisa también un 'interrupted' puesto al cerrar el turno: si la
      // tarea terminó de verdad, el panel lo dice.
      const ev = event
      return updateTask(r, ev.taskId, (t) => ({
        ...t,
        status: taskStatusFromSdk(ev.status) ?? 'done',
        endTime: ev.durationMs ? t.startTime + ev.durationMs : now,
        summary: ev.summary || t.summary,
        toolUses: ev.toolUses ?? t.toolUses,
      }))
    }
    case 'task_updated': {
      const ev = event
      const status = taskStatusFromSdk(ev.status)
      return updateTask(r, ev.taskId, (t) => ({
        ...t,
        description: ev.description || t.description,
        ...(status && t.status === 'running' ? { status, endTime: now } : {}),
      }))
    }
    case 'subagent_tool_start': {
      const ev = event
      const newStep: SubagentStep = { toolUseId: ev.toolUseId, name: ev.name, input: ev.input, status: 'running', startTime: now }
      const tools = r.tools.map((t) =>
        t.toolUseId === ev.parentToolUseId ? { ...t, subagentSteps: [...(t.subagentSteps ?? []), newStep] } : t,
      )
      return { ...r, tools, messages: syncToolsToBubbles(r.messages, tools) }
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
      return { ...r, tools, messages: syncToolsToBubbles(r.messages, tools) }
    }
    case 'subagent_text': {
      const ev = event
      const tools = r.tools.map((t) => (t.toolUseId === ev.parentToolUseId ? { ...t, subagentText: ev.text } : t))
      return { ...r, tools, messages: syncToolsToBubbles(r.messages, tools) }
    }
    case 'html_canvas': {
      // Lienzo HTML de la tool show_html. Igual que text/text_delta: si
      // needsNewAssistant está prendido (turno nuevo tras un ask_user_question
      // respondido), el lienzo tiene que abrir una burbuja assistant NUEVA — si no,
      // updateLastAssistant lo engancharía a la burbuja de ANTES de la pregunta
      // (la última con role:'assistant' en el array), que es del turno anterior.
      const canvas = { toolUseId: event.toolUseId, title: event.title, html: event.html }
      if (r.needsNewAssistant) {
        return {
          ...r,
          needsNewAssistant: false,
          messages: [...r.messages, {
            role: 'assistant',
            content: '',
            timestamp: now,
            tools: [],
            htmlCanvases: [canvas],
            agentContext: r.currentDelegation || undefined,
          }],
        }
      }
      return {
        ...r,
        messages: updateLastAssistant(r.messages, r.currentDelegation, (msg) => ({
          ...msg,
          htmlCanvases: [...(msg.htmlCanvases ?? []), canvas],
        })),
      }
    }
    case 'prompt_suggestions': {
      return { ...r, promptSuggestions: event.suggestions }
    }
    case 'status': {
      return event.message ? { ...r, statusMessage: event.message } : r
    }
    case 'done': {
      const d = event
      // El turno terminó: lo que sigue abierto ya no va a recibir resultado. Se cierra
      // ACÁ y no solo en handleDone (canal DONE) porque el assistant se persiste con este
      // evento: antes se guardaba con los pasos huérfanos en 'running'. Con la gate de
      // Bug #4 abierta (respuesta recién enviada) no se toca: los pasos son del turno vivo.
      const closed = rt.waitingAfterAnswer ? r : interruptOpenSteps(r, now)
      return {
        ...closed,
        stopRequested: false,
        sdkIdleMs: 0,
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
      // El error ya explica por qué se cortó (watchdog, límite, proceso): los pasos que
      // no recibieron resultado quedan interrumpidos, no «con error» — un Bash en cola
      // que ni llegó a ejecutarse no falló.
      return {
        ...interruptOpenSteps(r, now),
        error: event.message,
        errorCode: event.code ?? null,
        retryPrompt: event.retryPrompt ?? null,
        isStreaming: false,
        isPending: false,
        stopRequested: false,
        sdkIdleMs: 0,
        activeTool: null,
        activeAgentDelegation: null,
        currentDelegation: null,
      }
    }
    default:
      return r
  }
}

// ── Manejo de eventos done / ask_user_question ───────────────────────────────

/**
 * Las tools que corren mientras hay una pregunta abierta están esperando al usuario,
 * no trabajando: la UI muestra «Esperando tu respuesta» en vez del contador.
 */
function markAwaitingUser(rt: ConversationRuntime, awaiting: boolean): ConversationRuntime {
  // Los sub-pasos también: una pregunta hecha desde un subagente deja su paso esperando
  // al usuario, y el aviso de paso lento no debe contarlo como «tardando».
  const markSteps = (steps: SubagentStep[] | undefined): SubagentStep[] | undefined =>
    steps?.some((s) => s.status === 'running' && !!s.awaitingUser !== awaiting)
      ? steps.map((s) => (s.status === 'running' ? { ...s, awaitingUser: awaiting || undefined } : s))
      : steps
  const tools = rt.tools.map((t) => {
    const steps = markSteps(t.subagentSteps)
    if (t.status === 'running' && !!t.awaitingUser !== awaiting) return { ...t, awaitingUser: awaiting || undefined, subagentSteps: steps }
    return steps !== t.subagentSteps ? { ...t, subagentSteps: steps } : t
  })
  return { ...rt, tools, messages: syncToolsToBubbles(rt.messages, tools) }
}

function handleDone(conversationId: string): void {
  update(conversationId, (rt) => {
    // Bug #4: si el usuario acaba de responder ask_user_question y el agente aún
    // no emitió nada, un done viejo no debe resetear isStreaming/isPending.
    if (rt.waitingAfterAnswer) return rt
    return {
      ...interruptOpenSteps(rt, Date.now()),
      isStreaming: false,
      isPending: false,
      stopRequested: false,
      sdkIdleMs: 0,
      activeTool: null,
      activeAgentDelegation: null,
      currentDelegation: null,
    }
  })
  persistNewMessages(conversationId, getRuntime(conversationId))
}

// ── Suscripción IPC única (se monta una sola vez) ────────────────────────────

let ipcWired = false

/** Sin eventos con el agente ya trabajando: el main late cada 5 s, así que 90 s = no responde. */
const STALL_STREAMING_MS = 90_000
/** Sin el primer evento del turno: el arranque de una sesión nueva puede tardar varios minutos. */
const STALL_PENDING_MS = 12 * 60_000

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
      ...interruptOpenSteps(rt, Date.now()),
      error: err.message,
      errorCode: err.code ?? null,
      isStreaming: false,
      isPending: false,
      stopRequested: false,
      sdkIdleMs: 0,
      activeTool: null,
      activeAgentDelegation: null,
      currentDelegation: null,
    }))
  })

  window.cerpAPI.onAskUserQuestion((questions, conversationId) => {
    const id = conversationId || '__default__'
    // Lista vacía = el main canceló la pregunta (se cerró la sesión que la hizo): se
    // saca el widget, nadie espera ya esa respuesta.
    if (!questions?.length) {
      update(id, (rt) => ({ ...markAwaitingUser(rt, false), pendingQuestions: null, isSubmittingAnswers: false }))
      return
    }
    // Lo que venga después de la respuesta va a una burbuja nueva (no pisar lo de
    // antes). Ojo: NO es un turno nuevo — la tool que preguntó sigue abierta y el
    // agente continúa el MISMO turno (no llega stream_start). Por eso el acumulador
    // de texto se vacía acá: si no, la burbuja nueva repetía el texto de antes.
    update(id, (rt) => ({
      ...markAwaitingUser(rt, true),
      pendingQuestions: questions,
      needsNewAssistant: true,
      textAccumulator: EMPTY_TEXT_ACCUMULATOR,
    }))
  })

  // Timer de inactividad (fallback). Con un turno en curso el main late cada 5 s y su
  // propio watchdog corta un SDK colgado (con un error que ya trae Reintentar), así que
  // 90 s sin NINGÚN evento = el main dejó de responder. Antes esto apagaba el spinner en
  // silencio (RQM-166: el usuario no se enteraba de nada); ahora deja un error visible
  // con Reintentar. Antes del primer evento (isPending) el arranque de la sesión puede
  // tardar (config + contexto de empresa), por eso el margen es mayor.
  setInterval(() => {
    const now = Date.now()
    for (const [id, rt] of runtimes) {
      if (!rt.isStreaming && !rt.isPending) continue
      const stalledMs = now - rt.lastEvent
      if (stalledMs <= (rt.isPending ? STALL_PENDING_MS : STALL_STREAMING_MS)) continue
      update(id, (r) => {
        return {
          ...interruptOpenSteps(r, now),
          isStreaming: false,
          isPending: false,
          stopRequested: false,
          sdkIdleMs: 0,
          activeTool: null,
          activeAgentDelegation: null,
          currentDelegation: null,
          error: 'CERP IA dejó de responder y la ejecución se detuvo. Es un problema del sistema, no de tus datos. Lo que ya se cargó en CERP quedó guardado: pulsa «Reintentar» para continuar donde quedó.',
          errorCode: 'STALLED',
          retryPrompt: GENERIC_RETRY_PROMPT,
        }
      })
      // La sesión de esa conversación puede seguir viva pero inaccesible: se cierra para
      // que el reintento arranque una limpia (best-effort: si el main no responde, nada).
      window.cerpAPI.resetSession(id).catch(() => { /* main sin respuesta */ })
      persistNewMessages(id, getRuntime(id))
    }
  }, 5_000)
}

// ── API pública de acciones ──────────────────────────────────────────────────

export interface SendPromptOptions {
  /**
   * Regenerar (Ola 1) reenvía el ÚLTIMO prompt del usuario, que YA está en
   * `messages` (y ya persistido) de la vez anterior — sin esta opción,
   * `sendPrompt` agrega Y persiste un mensaje de usuario IDÉNTICO de nuevo,
   * duplicando la burbuja en el chat y en la DB. Con `skipUserEcho: true` no se
   * toca `messages` ni se persiste nada nuevo; solo se dispara la consulta.
   */
  skipUserEcho?: boolean
}

export async function sendPrompt(
  conversationId: string,
  prompt: string,
  cwd?: string,
  activeContextId?: string,
  modelChoice?: ModelChoice,
  options?: SendPromptOptions,
): Promise<void> {
  ensureIpcWired()
  // Snapshot del historial ANTES de agregar el mensaje del usuario (igual que useAgent).
  const prevMessages = getRuntime(conversationId).messages
  const history = prevMessages.map((m) => ({ role: m.role, content: m.content }))
  const skipUserEcho = options?.skipUserEcho ?? false

  // Lo que haya quedado abierto del turno anterior se cierra antes de vaciar `tools`:
  // si no, sus pasos quedaban 'running' en las burbujas viejas (p.ej. Detener y enviar
  // otro mensaje antes de que el main cerrara el turno abortado).
  update(conversationId, (prev) => {
    const rt = interruptOpenSteps(prev, Date.now())
    return {
      ...rt,
      error: null,
      errorCode: null,
      retryPrompt: null,
      isStreaming: true,
      isPending: true,
      stopRequested: false,
      sdkIdleMs: 0,
      lastEvent: Date.now(),
      activeTool: null,
      activeAgentDelegation: null,
      promptSuggestions: [],
      statusMessage: null,
      currentDelegation: null,
      waitingAfterAnswer: false,
      tools: [],
      textAccumulator: EMPTY_TEXT_ACCUMULATOR,
      // Sincroniza la carpeta de la conversación cuando el caller la pasa explícita
      // (ChatContainer ya la fija vía setConversationCwd; esto cubre otros callers).
      cwd: cwd !== undefined ? cwd : rt.cwd,
      messages: skipUserEcho ? rt.messages : [...rt.messages, { role: 'user', content: prompt, timestamp: Date.now() }],
    }
  })
  // Persistir el mensaje del usuario inmediatamente (salvo regeneración: ya está persistido).
  if (!skipUserEcho) {
    persistNewMessages(conversationId, getRuntime(conversationId))
  }

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

/**
 * Detener. El turno se cierra en la UI EN EL ACTO (pasos abiertos → 'interrupted') y
 * después se le pide al main que lo corte. Antes la UI esperaba la respuesta del main
 * para apagar el loader, y los pasos solo se cerraban si llegaba el `result` abortado:
 * con el SDK colgado, el Detener no hacía nada visible hasta el watchdog (15 min).
 */
export async function abort(conversationId: string): Promise<void> {
  update(conversationId, (rt) => ({
    ...interruptOpenSteps(rt, Date.now()),
    isStreaming: false,
    isPending: false,
    stopRequested: true,
    sdkIdleMs: 0,
    activeTool: null,
    activeAgentDelegation: null,
    pendingQuestions: null,
    isSubmittingAnswers: false,
    needsNewAssistant: false,
    waitingAfterAnswer: false,
    currentDelegation: null,
  }))
  await window.cerpAPI.abortAgent(conversationId)
}

/**
 * `delivered: false` = el main ya no esperaba esa respuesta (la ejecución que preguntó
 * terminó o se cortó): el widget se cierra y el caller debe mandar `fallbackPrompt`
 * como mensaje normal para que la respuesta no se pierda.
 */
export async function submitAnswers(
  conversationId: string,
  pendingQuestions: AskUserQuestionItem[],
  answers: UserAnswerPayload,
): Promise<{ delivered: boolean; fallbackPrompt: string }> {
  // Eco de las respuestas como mensaje de usuario (audit trail), igual que useAgent.
  const echoLines = pendingQuestions.map((q) => {
    const ans = answers[q.question]
    const ansText = Array.isArray(ans) ? ans.join(', ') : (ans ?? '(sin respuesta)')
    return `- **${q.header}**: ${ansText}`
  }).join('\n')
  const echoContent = pendingQuestions.length === 1
    ? `Respuesta: ${echoLines.replace(/^- \*\*[^*]+\*\*: /, '')}`
    : `Respondí:\n${echoLines}`

  // Si la pregunta ya no estaba activa en el main, la respuesta viaja como mensaje
  // normal: con el texto de cada pregunta, porque el agente ya no tiene la tool abierta.
  const fallbackPrompt = 'Respondo a tus preguntas:\n' + pendingQuestions.map((q) => {
    const ans = answers[q.question]
    return `- ${q.question} → ${Array.isArray(ans) ? ans.join(', ') : (ans ?? '(sin respuesta)')}`
  }).join('\n')

  update(conversationId, (prev) => {
    const rt = markAwaitingUser(prev, false)
    return {
      ...rt,
      messages: [...rt.messages, { role: 'user', content: echoContent, timestamp: Date.now() }],
      isSubmittingAnswers: true,
      waitingAfterAnswer: true,
      isPending: true,
      isStreaming: true,
      lastEvent: Date.now(),
    }
  })
  persistNewMessages(conversationId, getRuntime(conversationId))

  let delivered = true
  try {
    delivered = await window.cerpAPI.submitUserAnswers(conversationId, answers)
    update(conversationId, (rt) => (delivered
      ? { ...rt, pendingQuestions: null }
      : { ...rt, pendingQuestions: null, waitingAfterAnswer: false, isPending: false, isStreaming: false }))
  } finally {
    update(conversationId, (rt) => ({ ...rt, isSubmittingAnswers: false }))
  }
  return { delivered, fallbackPrompt }
}

/** Restaura mensajes de una conversación cargada de la DB (no re-persistir).
 *  `cwd` restaura la carpeta de trabajo persistida en metadata.cwd. */
export function restoreMessages(conversationId: string, messages: ChatMessage[], cwd?: string | null): void {
  ensureIpcWired()
  seedPersisted(conversationId, messages)
  // Orden por hora: el eco «Respuesta: …» se guarda al responder y la burbuja que
  // preguntó recién al cerrar el turno, así que en la DB quedan al revés.
  // `sort` es estable: con la misma hora se respeta el orden guardado.
  const ordered = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
  update(conversationId, () => ({ ...freshRuntime(), messages: ordered, cwd: cwd ?? null }))
}

/** Fija la carpeta de trabajo de UNA conversación (per-conversación, no global). */
export function setConversationCwd(conversationId: string, cwd: string | null): void {
  update(conversationId, (rt) => ({ ...rt, cwd }))
}

/** Limpia el runtime de una conversación (al borrarla, p.ej.). */
export function clearRuntime(conversationId: string): void {
  runtimes.delete(conversationId)
  persistedKeys.delete(conversationId)
  notify(conversationId)
}

export { ensureIpcWired }
