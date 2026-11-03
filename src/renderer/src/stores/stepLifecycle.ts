import type { BackgroundTask, StepStatus, SubagentStep, ToolExecution } from '../hooks/useAgent'

/**
 * stepLifecycle — ciclo de vida de los pasos del agente (tools y sub-pasos de
 * subagentes) en el renderer. Funciones puras, sin React ni IPC: las usan el store
 * (agentRuntimeStore), la carga de conversaciones (useConversations) y los componentes.
 *
 * Regla: un paso solo está 'running' mientras su turno sigue vivo. Cualquier camino que
 * cierra el turno (done, error, Detener, cierre de sesión, stall, envío nuevo) pasa lo
 * que quedó abierto a 'interrupted'. Antes se cerraban como 'done' o 'error' (o no se
 * cerraban), y un paso que nunca recibió su resultado quedaba con spinner y contador
 * durante horas: el caso de Facundo en v1.0.40, con un Bash 921 min en «Ejecutando
 * comando» que en realidad nunca llegó a ejecutarse (esperaba en cola detrás de un
 * subagente colgado).
 */

/**
 * Un paso (no delegación) que corre más que esto muestra «Este paso está tardando más
 * de lo normal» y un «Detener». Un Bash pasa a segundo plano a los 2 min y una llamada
 * al core corta a los 5, así que 3 min sin resultado ya no es lo habitual.
 */
export const SLOW_STEP_NOTICE_MS = 3 * 60_000

/** Con el SDK sin mandar nada hace este tiempo (lo dice el heartbeat del main), el loader lo muestra. */
export const SDK_IDLE_NOTICE_MS = 3 * 60_000

/** Agent (antes Task, hasta Claude Code v2.1.63) = delegación a un subagente. */
export function isDelegationTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

export function isTerminalStatus(status: StepStatus): boolean {
  return status !== 'running'
}

/**
 * Status persistido → status de la UI. El backend lo guarda como string libre. Una
 * conversación cargada de disco no tiene ningún turno vivo: lo que se guardó como
 * 'running' (un paso sin resultado al cerrar el turno, en versiones anteriores) es un
 * paso interrumpido, no uno exitoso. Sin status (registros viejos) se toma como 'done'.
 */
export function normalizePersistedStatus(status: unknown): StepStatus {
  if (status === 'error') return 'error'
  if (status === 'running' || status === 'interrupted') return 'interrupted'
  return 'done'
}

function interruptSteps(steps: SubagentStep[] | undefined, now: number): SubagentStep[] | undefined {
  if (!steps?.some((s) => s.status === 'running')) return steps
  return steps.map((s) => (s.status === 'running' ? { ...s, status: 'interrupted' as const, endTime: now, awaitingUser: undefined } : s))
}

/**
 * Cierre del turno: todo lo que quedó 'running' (tools y sub-pasos de subagente) pasa a
 * 'interrupted'. Devuelve la misma referencia si no había nada abierto.
 */
export function interruptRunningSteps(tools: ToolExecution[], now: number): ToolExecution[] {
  let changed = false
  const next = tools.map((t) => {
    const steps = interruptSteps(t.subagentSteps, now)
    if (t.status === 'running') {
      changed = true
      return { ...t, status: 'interrupted' as const, endTime: now, awaitingUser: undefined, subagentSteps: steps }
    }
    if (steps !== t.subagentSteps) {
      changed = true
      return { ...t, subagentSteps: steps }
    }
    return t
  })
  return changed ? next : tools
}

/**
 * Cierre del turno para las tareas de fondo del SDK: las que siguen 'running' pasan a
 * 'interrupted', igual que los pasos. Si después llega su task_notification, el resultado
 * real la pisa (ver applyEvent). Devuelve la misma referencia si no había nada abierto.
 */
export function interruptRunningTasks(tasks: BackgroundTask[], now: number): BackgroundTask[] {
  if (!tasks.some((t) => t.status === 'running')) return tasks
  return tasks.map((t) => (t.status === 'running' ? { ...t, status: 'interrupted' as const, endTime: now } : t))
}

/**
 * Estado de una tarea según el SDK → estado de la UI. task_notification trae completed |
 * failed | stopped; task_updated además pending | running | paused | killed. null = no es
 * un estado final (la tarea sigue corriendo).
 */
export function taskStatusFromSdk(status: string | undefined): StepStatus | null {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'stopped' || status === 'killed') return 'interrupted'
  return null
}

/**
 * Inicio del paso corriendo más antiguo que puede estar «tardando»: tools que no son
 * delegaciones y sub-pasos de subagente, sin contar los que esperan al usuario. null si
 * no hay ninguno. Lo usa el loader para el aviso de paso lento.
 */
export function oldestRunningStepStart(tools: ToolExecution[] | undefined): number | null {
  let oldest: number | null = null
  const consider = (start: number): void => { if (oldest === null || start < oldest) oldest = start }
  for (const t of tools ?? []) {
    if (t.status !== 'running') continue
    if (isDelegationTool(t.name)) {
      for (const s of t.subagentSteps ?? []) if (s.status === 'running' && !s.awaitingUser) consider(s.startTime)
    } else if (!t.awaitingUser) {
      consider(t.startTime)
    }
  }
  return oldest
}
