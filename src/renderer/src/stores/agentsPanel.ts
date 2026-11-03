import type { BackgroundTask, ChatMessage, StepStatus, SubagentStep, ToolExecution } from '../hooks/useAgent'
import { isDelegationTool } from './stepLifecycle'

/**
 * agentsPanel — modelo del panel lateral «Agentes». Funciones puras, sin React ni IPC.
 *
 * No hay un estado aparte que mantener en sincronía: las filas se DERIVAN de lo que el
 * runtime ya tiene. Las delegaciones (tool Agent/Task) salen de las burbujas del
 * asistente —todas las del historial, así que una conversación recargada también
 * muestra las de sus turnos anteriores— y las tareas de fondo del SDK, de
 * `backgroundTasks`. Una tarea lanzada por una delegación (mismo `toolUseId`) es la
 * misma fila: un Agent en segundo plano devuelve su tool_result enseguida («corriendo en
 * segundo plano») y sigue trabajando hasta su task_notification.
 *
 * Al cerrarse un turno, los pasos y las tareas abiertas pasan a 'interrupted'
 * (stepLifecycle.ts), así que ninguna fila queda «trabajando» con el turno cerrado.
 */

/** Qué es la fila: una delegación a un especialista, un Workflow, un comando en segundo plano u otra tarea del SDK. */
export type AgentEntryKind = 'agent' | 'workflow' | 'shell' | 'task'

export interface AgentEntry {
  /** Clave estable de la fila (toolUseId, taskId o, en conversaciones recargadas, la posición). */
  id: string
  kind: AgentEntryKind
  /** Nombre del especialista tal como lo manda el SDK (p.ej. 'excel-analyst'); vacío si no lo informó. */
  agentName?: string
  /** La tarea en una línea. */
  task: string
  /** La tarea completa (title de la fila). */
  fullTask: string
  status: StepStatus
  /** Corre pero espera la respuesta del usuario. */
  awaitingUser?: boolean
  startTime: number
  endTime?: number
  /** Pasos (tools) que hizo el subagente, en orden. */
  steps: SubagentStep[]
  /** Cantidad de pasos: los pasos recibidos o, sin ellos, las tools que informó el SDK. */
  stepCount: number
  /** Paso en curso (el último 'running'). */
  currentStep?: SubagentStep
  /** Última tool que informó el SDK para una tarea de fondo (task_progress). */
  lastToolName?: string
  /** Último texto del subagente, o el resumen del SDK para una tarea de fondo. */
  lastText?: string
}

/** Workflow: un tool propio, que el SDK sigue como tarea 'local_workflow'. */
function isWorkflowTool(name: string): boolean {
  return name === 'Workflow'
}

/** Tipo de fila según el task_type crudo del SDK. */
export function taskKind(task: BackgroundTask): AgentEntryKind {
  const type = (task.taskType ?? '').toLowerCase()
  if (task.workflowName || type.includes('workflow')) return 'workflow'
  if (type.includes('bash') || type.includes('shell')) return 'shell'
  if (task.subagentType || type.includes('agent')) return 'agent'
  return 'task'
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/**
 * Estado de una delegación cruzada con su tarea de fondo. Un error de la tool manda; una
 * tarea terminada dice cómo terminó el agente (aunque su tool_result no haya llegado);
 * una tarea viva con la tool ya devuelta es un agente en segundo plano: sigue trabajando.
 */
function delegationStatus(tool: ToolExecution, task: BackgroundTask | undefined): StepStatus {
  if (tool.status === 'error') return 'error'
  if (!task) return tool.status
  if (task.status !== 'running') return task.status
  return tool.status === 'interrupted' ? 'interrupted' : 'running'
}

function currentStepOf(steps: SubagentStep[]): SubagentStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === 'running') return steps[i]
  return undefined
}

function entryFromTool(tool: ToolExecution, id: string, task: BackgroundTask | undefined): AgentEntry {
  const workflow = isWorkflowTool(tool.name)
  const steps = tool.subagentSteps ?? []
  const status = delegationStatus(tool, task)
  const fullTask = (workflow ? task?.description : undefined)
    || tool.taskDescription
    || tool.taskPrompt
    || tool.input
    || task?.description
    || ''
  const running = status === 'running'
  return {
    id,
    kind: workflow ? 'workflow' : 'agent',
    agentName: tool.agentName || task?.subagentType,
    task: firstLine(fullTask),
    fullTask: [tool.taskDescription, tool.taskPrompt].filter(Boolean).join('\n\n') || fullTask,
    status,
    awaitingUser: running && (tool.awaitingUser || !!currentStepOf(steps)?.awaitingUser),
    startTime: tool.startTime,
    endTime: running ? undefined : (task && task.status !== 'running' ? task.endTime : tool.endTime),
    steps,
    stepCount: steps.length || task?.toolUses || 0,
    currentStep: running ? currentStepOf(steps) : undefined,
    lastToolName: task?.lastToolName,
    lastText: firstLine(tool.subagentText) || firstLine(task?.summary) || undefined,
  }
}

function entryFromTask(task: BackgroundTask): AgentEntry {
  return {
    id: task.taskId,
    kind: taskKind(task),
    agentName: task.subagentType,
    task: firstLine(task.description),
    fullTask: task.description,
    status: task.status,
    startTime: task.startTime,
    endTime: task.status === 'running' ? undefined : task.endTime,
    steps: [],
    stepCount: task.toolUses ?? 0,
    lastToolName: task.lastToolName,
    lastText: firstLine(task.summary) || undefined,
  }
}

/**
 * Filas del panel de una conversación: delegaciones y Workflows de todas las burbujas,
 * más las tareas de fondo que no pertenecen a ninguno de ellos. En curso primero (la más
 * antigua arriba, en el orden en que se lanzaron); terminadas después, la más reciente arriba.
 */
export function deriveAgentEntries(messages: ChatMessage[], backgroundTasks: BackgroundTask[]): AgentEntry[] {
  const tasksByToolUse = new Map<string, BackgroundTask>()
  for (const t of backgroundTasks) if (t.toolUseId) tasksByToolUse.set(t.toolUseId, t)

  const entries: AgentEntry[] = []
  const seenToolUse = new Set<string>()
  messages.forEach((m, mi) => {
    if (m.role !== 'assistant' || !m.tools?.length) return
    m.tools.forEach((tool, ti) => {
      if (!isDelegationTool(tool.name) && !isWorkflowTool(tool.name)) return
      if (tool.toolUseId) {
        if (seenToolUse.has(tool.toolUseId)) return
        seenToolUse.add(tool.toolUseId)
      }
      // Las conversaciones recargadas no guardan el toolUseId: la posición es estable.
      const id = tool.toolUseId ?? `m${mi}-t${ti}`
      entries.push(entryFromTool(tool, id, tool.toolUseId ? tasksByToolUse.get(tool.toolUseId) : undefined))
    })
  })
  for (const task of backgroundTasks) {
    if (task.toolUseId && seenToolUse.has(task.toolUseId)) continue
    entries.push(entryFromTask(task))
  }

  const running = entries.filter((e) => e.status === 'running').sort((a, b) => a.startTime - b.startTime)
  const finished = entries
    .filter((e) => e.status !== 'running')
    .sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime))
  return [...running, ...finished]
}

/**
 * Las fuentes de las filas (cada tool de delegación y cada tarea), para saber si las
 * filas cambiaron sin recalcularlas: el texto que llega token a token crea un array de
 * mensajes nuevo en cada delta pero no toca estas referencias.
 */
export function agentEntrySources(messages: ChatMessage[], backgroundTasks: BackgroundTask[]): unknown[] {
  const sources: unknown[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tools?.length) continue
    for (const t of m.tools) if (isDelegationTool(t.name) || isWorkflowTool(t.name)) sources.push(t)
  }
  for (const t of backgroundTasks) sources.push(t)
  return sources
}

export function countRunningEntries(entries: AgentEntry[]): number {
  return entries.filter((e) => e.status === 'running').length
}
