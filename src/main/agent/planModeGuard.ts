import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../utils/logger'

/**
 * Modo plan — estado global y bloqueo estructural de escrituras.
 *
 * Hasta v1.0.45 el Modo plan era SOLO un texto en el prompt de sistema: nada impedía
 * que el modelo llamara a una tool de escritura. En el caso Cresata (5-11) anunció
 * «Añado las 11 partidas» con el modo activo y el turno quedó colgado. Ahora cada tool
 * del servidor `cerp` que no sea de solo lectura devuelve un error inmediato mientras
 * el modo está activo, y el modelo tiene que cortar y pedir que se desactive.
 */
let planModeEnabled = false

export function getPlanModeState(): boolean {
  return planModeEnabled
}

export function setPlanModeState(enabled: boolean): void {
  planModeEnabled = enabled
}

/**
 * Tools no-readOnly que SÍ pueden correr en Modo plan:
 * - `ask_user_question`: es como el agente pregunta mientras planifica.
 * - `quote_reserve` / `quote_refund` / `quote_register_files` / `quote_mark_synced`:
 *   cortafuegos de créditos; no tocan datos del negocio y la cotización reserva al
 *   inicio, antes del plan. `quote_commit` y `quote_consume_*` quedan bloqueadas: sin
 *   presupuesto escrito no hay nada que confirmar.
 * - `run_app_tool` e `import_budget_rows`: deciden ellas mismas (lectura de una app sin
 *   confirmación y vista previa con dryRun sí; envío o import real no). Ver
 *   `blockIfPlanMode` en sus handlers.
 */
const ALLOWED_IN_PLAN_MODE = new Set([
  'ask_user_question',
  'quote_reserve',
  'quote_refund',
  'quote_register_files',
  'quote_mark_synced',
  'run_app_tool',
  'import_budget_rows',
])

export function isBlockedInPlanMode(name: string, readOnly: boolean | undefined): boolean {
  if (readOnly === true) return false
  return !ALLOWED_IN_PLAN_MODE.has(name)
}

/** Para las tools que deciden por argumento: el resultado de error, o null si puede seguir. */
export function blockIfPlanMode(toolName: string, isWrite: boolean) {
  if (!isWrite || !getPlanModeState()) return null
  logger.warn(`Modo plan: bloqueada la escritura de ${toolName}`)
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: PLAN_MODE_BLOCKED_MESSAGE, planMode: true }) }],
    isError: true,
  }
}

export const PLAN_MODE_BLOCKED_MESSAGE =
  'Modo plan activado: esta acción escribe datos (en CERP o hacia una app conectada) y no se ejecutó. ' +
  'No vuelvas a intentarlo ni digas que lo hiciste. Terminá el turno ahora: mostrá el plan ' +
  'completo y pedile al usuario que desactive el Modo plan (el interruptor junto al botón Enviar) ' +
  'y te responda para ejecutarlo.'

/**
 * Envuelve las tools de escritura para que, con el Modo plan activo, devuelvan un error
 * en lugar de ejecutarse (y en lugar de abrir una tarjeta de confirmación que dejaría el
 * turno esperando). El estado se lee en cada llamada: no hace falta recrear el servidor.
 */
export function guardWritesInPlanMode<T extends SdkMcpToolDefinition<any>>(
  tools: T[],
  isPlanMode: () => boolean = getPlanModeState,
): T[] {
  return tools.map((t) => {
    if (!isBlockedInPlanMode(t.name, t.annotations?.readOnlyHint)) return t
    const original = t.handler
    return {
      ...t,
      handler: async (args: any, extra: unknown) => {
        if (isPlanMode()) {
          logger.warn(`Modo plan: bloqueada la tool de escritura ${t.name}`)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: PLAN_MODE_BLOCKED_MESSAGE, planMode: true }) }],
            isError: true,
          }
        }
        return original(args, extra)
      },
    }
  })
}
