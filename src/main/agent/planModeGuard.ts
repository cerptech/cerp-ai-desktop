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
 * Escrituras que SÍ pueden correr en Modo plan:
 * - `ask_user_question`: es como el agente pregunta mientras planifica.
 * - `quote_*`: cortafuegos de créditos (reserva/commit/refund/registro); no tocan datos
 *   del negocio y el flujo de cotización las llama al inicio, antes de cualquier plan.
 */
const ALLOWED_WRITES_IN_PLAN_MODE = new Set(['ask_user_question'])

export function isBlockedInPlanMode(name: string, readOnly: boolean | undefined): boolean {
  if (readOnly === true) return false
  if (name.startsWith('quote_')) return false
  return !ALLOWED_WRITES_IN_PLAN_MODE.has(name)
}

export const PLAN_MODE_BLOCKED_MESSAGE =
  'Modo plan activado: esta herramienta modifica datos en CERP y no se ejecutó. ' +
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
