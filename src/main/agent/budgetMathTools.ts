import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { logger } from '../utils/logger'

/**
 * Cálculo de presupuestos por código, no por el modelo (caso Cresata, 26-10).
 *
 * La tabla del plan (paso 1c) se armaba con sumas «de cabeza»: el modelo se equivocó
 * en totales y diferencias y, al reformular, perdió partidas sin decirlo. Esta tool:
 *
 * 1. Calcula importe por partida, subtotales por capítulo, PEM, GG, BI, PEC, IVA y total
 *    con la misma regla de redondeo que el core (ADR 027): importe = round2(cantidad ×
 *    round2(precio unitario)), y cada capa redondeada a 2 decimales.
 * 2. Si recibe la versión anterior (`previousItems`), devuelve qué partidas se añaden,
 *    se quitan o cambian, para que ninguna desaparezca en silencio.
 *
 * Es local y pura (no llama al backend ni escribe nada): corre también en Modo plan.
 * El presupuesto ya guardado en CERP se recalcula en el core (`recalculate_budget`).
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

const ItemSchema = z.object({
  code: z.string().optional().describe('Codigo de la partida (si tiene). Se usa para emparejarla con la version anterior.'),
  chapter: z.string().optional().describe('Capitulo al que pertenece (nombre o numero)'),
  description: z.string().describe('Descripcion de la partida'),
  unit: z.string().optional(),
  quantity: z.number().describe('Medicion (cantidad). Si la medicion esta pendiente, 0 y status "pendiente".'),
  unitPrice: z.number().describe('Precio unitario sin impuestos'),
  status: z.enum(['medida', 'pendiente']).optional().describe('"pendiente" si la cantidad no sale de una cota del plano'),
})

const ComputeBudgetTotalsSchema = z.object({
  items: z.array(ItemSchema).min(1).describe('TODAS las partidas del presupuesto propuesto'),
  ggPercent: z.number().min(0).max(100).optional().describe('Gastos generales en % sobre PEM (ej. 13)'),
  biPercent: z.number().min(0).max(100).optional().describe('Beneficio industrial en % sobre PEM (ej. 6)'),
  ivaPercent: z.number().min(0).max(100).optional().describe('IVA en % sobre PEM+GG+BI (ej. 21 o 10)'),
  previousItems: z
    .array(ItemSchema)
    .optional()
    .describe('Partidas de la version ANTERIOR, si estas reformulando. Devuelve que se añade, se quita y cambia.'),
})

type Item = z.infer<typeof ItemSchema>

function itemKey(it: Item): string {
  const code = it.code?.trim().toLowerCase()
  if (code) return `c:${code}`
  return `d:${it.description.trim().toLowerCase().replace(/\s+/g, ' ')}`
}

function amountOf(it: Item): number {
  return round2(it.quantity * round2(it.unitPrice))
}

export function computeBudgetTotals(input: z.infer<typeof ComputeBudgetTotalsSchema>) {
  const items = input.items.map((it) => ({ ...it, amount: amountOf(it) }))

  const chapters = new Map<string, { chapter: string; items: number; subtotal: number }>()
  for (const it of items) {
    const name = it.chapter?.trim() || 'Sin capitulo'
    const ch = chapters.get(name) ?? { chapter: name, items: 0, subtotal: 0 }
    ch.items += 1
    ch.subtotal = round2(ch.subtotal + it.amount)
    chapters.set(name, ch)
  }

  const pem = round2(items.reduce((s, it) => s + it.amount, 0))
  const gg = round2(pem * ((input.ggPercent ?? 0) / 100))
  const bi = round2(pem * ((input.biPercent ?? 0) / 100))
  const pec = round2(pem + gg + bi)
  const iva = round2(pec * ((input.ivaPercent ?? 0) / 100))
  const total = round2(pec + iva)

  const pending = items.filter((it) => it.status === 'pendiente' || it.quantity === 0).map((it) => it.description)

  let changes: Record<string, unknown> | undefined
  if (input.previousItems) {
    const prev = new Map(input.previousItems.map((it) => [itemKey(it), { ...it, amount: amountOf(it) }]))
    const next = new Map(items.map((it) => [itemKey(it), it]))
    const added = items.filter((it) => !prev.has(itemKey(it))).map((it) => ({ code: it.code, description: it.description, amount: it.amount }))
    const removed = [...prev.entries()]
      .filter(([k]) => !next.has(k))
      .map(([, it]) => ({ code: it.code, description: it.description, amount: it.amount }))
    const modified = items
      .filter((it) => prev.has(itemKey(it)))
      .map((it) => ({ it, before: prev.get(itemKey(it))! }))
      .filter(({ it, before }) => it.quantity !== before.quantity || round2(it.unitPrice) !== round2(before.unitPrice))
      .map(({ it, before }) => ({
        code: it.code,
        description: it.description,
        quantity: { before: before.quantity, after: it.quantity },
        unitPrice: { before: round2(before.unitPrice), after: round2(it.unitPrice) },
        amount: { before: before.amount, after: it.amount, delta: round2(it.amount - before.amount) },
      }))
    const previousPem = round2([...prev.values()].reduce((s, it) => s + it.amount, 0))
    changes = {
      added,
      removed,
      modified,
      previousPem,
      pemDelta: round2(pem - previousPem),
      pemDeltaPercent: previousPem > 0 ? round2(((pem - previousPem) / previousPem) * 100) : null,
    }
  }

  return {
    items: items.map((it) => ({ code: it.code, chapter: it.chapter, description: it.description, quantity: it.quantity, unitPrice: round2(it.unitPrice), amount: it.amount, status: it.status })),
    chapters: [...chapters.values()],
    totals: { pem, gg, bi, pec, iva, total, itemCount: items.length },
    pendingMeasurements: pending,
    ...(changes ? { changes } : {}),
    note: 'Importes calculados por codigo (ADR 027). Copia estas cifras tal cual: no recalcules ni redondees a mano.',
  }
}

export function createBudgetMathTools() {
  const computeBudgetTotalsTool = tool(
    'compute_budget_totals',
    'Calcula por codigo los importes de un presupuesto propuesto: importe de cada partida, subtotales por capitulo, PEM, GG, BI, PEC, IVA y total. ' +
      'OBLIGATORIA antes de mostrar cualquier tabla de presupuesto, total o diferencia entre versiones: NUNCA sumes ni calcules porcentajes de cabeza. ' +
      'Si estas reformulando, pasale tambien previousItems y te devuelve las partidas añadidas, quitadas y modificadas. ' +
      'No escribe nada en CERP (funciona en Modo plan). Para un presupuesto ya guardado en CERP usa recalculate_budget.',
    ComputeBudgetTotalsSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const result = computeBudgetTotals(ComputeBudgetTotalsSchema.parse(args))
        logger.info(`compute_budget_totals OK: ${result.totals.itemCount} partidas, total ${result.totals.total}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`compute_budget_totals FAILED: ${message}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )
  return [computeBudgetTotalsTool]
}
