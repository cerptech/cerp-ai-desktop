import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tool de CRÉDITOS (Modelo CERP) para el cliente desktop.
 *
 * # Por qué vive acá y no en toolDefinitions.ts
 *
 * El resto de las tools son proxies REST declarativos (endpoint + schema): al
 * modelo le alcanza con la respuesta cruda del backend. Esta no, por dos motivos:
 *
 * 1. **La unidad de negocio no es la unidad del backend.** El ledger guarda el
 *    saldo en CENTÉSIMAS de crédito (ADR 008 — 1 crédito = $0,20 de coste real)
 *    para no perder precisión en la contabilidad interna. Devolverle esa unidad
 *    al modelo tal cual es un desastre esperando a pasar: hay que dividir por
 *    100 antes de que el modelo se la repita al usuario.
 * 2. **Dos casos del shape crudo son ambiguos sin contexto:**
 *    - `mode: 'off'` no significa "0 créditos". Significa que el modelo de
 *      créditos no está activo en esta cuenta (`CREDITS_MODE=off`): no hay
 *      límite ni cobro por uso de IA. Sin esta traducción el agente le diría al
 *      usuario "te quedan 0 créditos" en una cuenta sin ese concepto.
 *    - `unlimited: true` (plan Enterprise) puede convivir con los campos de
 *      saldo en 0 — no se les acredita nada porque no hace falta. Sin marcarlo
 *      aparte, el agente lee 0 y le avisa al usuario que se quedó sin créditos
 *      en un plan que no tiene tope.
 *
 * # Distinta de quote_eligibility (el cortafuegos de cotización)
 *
 * `get_credit_balance` es puramente INFORMATIVA: sirve para responder "¿cuántos
 * créditos me quedan?" o "¿qué plan tengo?". NO reserva nada, no toca el ledger
 * y NO reemplaza a `quote_eligibility` — esa es la que de verdad valida y
 * reserva el cobro antes de generar una cotización (ver systemPrompt.ts, sección
 * COTIZACION). Un agente que confunda las dos podría saltarse el cortafuegos
 * pensando que ya validó elegibilidad con esta tool.
 *
 * # Contrato con el core (no hay backend nuevo)
 *
 * - `GET /api/credits/balance` — requiere sesión autenticada; el companyId (y el
 *   userId cuando el saldo es por usuario) sale SIEMPRE del JWT (ADR 007), no
 *   hay forma de consultar otra empresa desde el chat.
 */

/**
 * Shape de la respuesta del endpoint. Coincide con `CreditsBalance` en
 * src/preload/index.ts (líneas 244-254), con el agregado de `scope`: al momento
 * de escribir esto ese campo NO está en el tipo del preload, así que se deja
 * opcional acá para no romper el parseo si el backend no lo manda.
 */
interface CreditBalanceResponse {
  mode: 'off' | 'shadow' | 'enforce'
  plan: string
  unlimited: boolean
  planBalanceHundredths: number
  topupBalanceHundredths: number
  reservedHundredths: number
  availableHundredths: number
  // null = sin tope mensual. Hoy solo Enterprise (que sale antes por la rama
  // `unlimited`), pero si un plan futuro sin tope no resolviera a enterprise,
  // Math.round(null)/100 daria 0 y el agente reportaria "0 creditos mensuales".
  monthlyCreditHundredths: number | null
  scope?: 'user' | 'company' | string
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
}

/** Centesimas de credito -> creditos (2 decimales, evita ruido de punto flotante). */
function hundredthsToCredits(hundredths: number): number {
  return Math.round(hundredths) / 100
}

const GetCreditBalanceSchema = z.object({})

export function createCreditsTools(httpClient: HttpClient) {
  // ── get_credit_balance ────────────────────────────────────────────────────
  const getCreditBalanceTool = tool(
    'get_credit_balance',
    'Consulta el saldo de creditos de IA del usuario/empresa en CERP: plan contratado, creditos del mes, recargas, reservados y disponibles. ' +
      'Usar cuando el usuario pregunte cuantos creditos le quedan, cual es su plan de CERP IA, o si le alcanza para seguir usando la IA. ' +
      'Es SOLO informativa: no reserva ni consume nada, y NO reemplaza a quote_eligibility antes de generar una cotizacion.',
    GetCreditBalanceSchema as any,
    async () => {
      try {
        const res = (await httpClient.get('/credits/balance')) as CreditBalanceResponse

        if (res.mode === 'off') {
          logger.info('get_credit_balance OK: modelo de creditos off')
          return textResult({
            modoCreditosActivo: false,
            nota:
              'El modelo de creditos no esta activo en esta cuenta: no hay limite ni cobro por uso de IA. ' +
              'La elegibilidad para cotizar se consulta con quote_eligibility, no con esta tool.',
          })
        }

        if (res.unlimited) {
          logger.info(`get_credit_balance OK: plan ${res.plan} ilimitado`)
          return textResult({
            plan: res.plan,
            ilimitado: true,
            alcance: res.scope === 'user' ? 'usuario' : 'empresa',
            nota:
              'Plan sin tope de creditos (Enterprise). No reportes un saldo en 0 como si fuera "sin creditos": ' +
              'en este plan los campos de saldo pueden venir en 0 porque no hace falta acreditar nada.',
          })
        }

        logger.info(`get_credit_balance OK: plan ${res.plan}, disponibles=${hundredthsToCredits(res.availableHundredths)}`)
        return textResult({
          plan: res.plan,
          ilimitado: false,
          alcance: res.scope === 'user' ? 'usuario' : 'empresa',
          creditosDisponibles: hundredthsToCredits(res.availableHundredths),
          creditosPlan: hundredthsToCredits(res.planBalanceHundredths),
          creditosRecarga: hundredthsToCredits(res.topupBalanceHundredths),
          creditosReservados: hundredthsToCredits(res.reservedHundredths),
          creditosMensualesDelPlan:
            res.monthlyCreditHundredths === null ? null : hundredthsToCredits(res.monthlyCreditHundredths),
          nota:
            'Los creditos del plan se resetean cada mes sin acumular; los de recarga no vencen. ' +
            'Para recargar o cambiar de plan: app.cerp.es -> Configuracion -> Suscripcion.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`get_credit_balance FAILED: ${message}`)
        return errorResult(
          err instanceof HttpError && err.status === 403
            ? 'Este usuario no tiene permiso para consultar el saldo de creditos.'
            : 'No se pudo consultar el saldo de creditos en este momento. Intenta de nuevo mas tarde.',
        )
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )

  return [getCreditBalanceTool]
}
