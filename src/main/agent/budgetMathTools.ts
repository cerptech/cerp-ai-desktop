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

/**
 * Misma implementación que `toCents` del core (cerp-server, budgetPricing/salePricing.ts):
 * half-up simétrico, con `toPrecision(15)` para absorber el ruido binario.
 */
export function round2(x: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0
  const cents = Math.round(Number((Math.abs(x) * 100).toPrecision(15)))
  if (cents === 0) return 0
  return (x < 0 ? -cents : cents) / 100
}

const ItemSchema = z.object({
  code: z.string().optional().describe('Codigo de la partida (si tiene). Se usa para emparejarla con la version anterior.'),
  chapter: z.string().optional().describe('Capitulo al que pertenece (nombre o numero)'),
  description: z.string().describe('Descripcion de la partida'),
  unit: z.string().optional(),
  quantity: z.number().min(0).describe('Medicion (cantidad). Si la medicion esta pendiente, 0 y status "pendiente" (cuenta 0 en el total).'),
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

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Empareja partidas entre versiones, uno a uno, en tres pasadas: mismo código (si las
 * dos lo tienen), mismo capítulo + descripción, y misma descripción. Cada partida se
 * empareja como mucho una vez, así dos «Puerta de paso» no se pisan, y una partida que
 * gana o pierde el código o el capítulo no aparece como quitada y añadida a la vez.
 * Devuelve, para cada índice de `next`, el índice emparejado de `prev` (o -1).
 */
function matchItems(prev: Item[], next: Item[]): number[] {
  const used = new Set<number>()
  const match = next.map(() => -1)
  const passes: Array<(a: Item, b: Item) => boolean> = [
    (a, b) => !!norm(a.code) && norm(a.code) === norm(b.code),
    (a, b) => norm(a.chapter) === norm(b.chapter) && norm(a.description) === norm(b.description),
    (a, b) => norm(a.description) === norm(b.description),
  ]
  for (const same of passes) {
    next.forEach((n, i) => {
      if (match[i] !== -1) return
      const j = prev.findIndex((p, k) => !used.has(k) && same(p, n))
      if (j !== -1) {
        match[i] = j
        used.add(j)
      }
    })
  }
  return match
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
    const prevItems = input.previousItems.map((it) => ({ ...it, amount: amountOf(it) }))
    const match = matchItems(prevItems, items)
    const matchedPrev = new Set(match.filter((j) => j !== -1))
    const brief = (it: Item & { amount: number }) => ({ code: it.code, chapter: it.chapter, description: it.description, amount: it.amount })
    const added = items.filter((_, i) => match[i] === -1).map(brief)
    const removed = prevItems.filter((_, j) => !matchedPrev.has(j)).map(brief)
    const modified = items
      .map((it, i) => ({ it, before: match[i] === -1 ? undefined : prevItems[match[i]] }))
      .filter((x): x is { it: (typeof items)[number]; before: (typeof prevItems)[number] } => x.before !== undefined)
      .filter(({ it, before }) => it.quantity !== before.quantity || round2(it.unitPrice) !== round2(before.unitPrice))
      .map(({ it, before }) => ({
        code: it.code,
        chapter: it.chapter,
        description: it.description,
        quantity: { before: before.quantity, after: it.quantity },
        unitPrice: { before: round2(before.unitPrice), after: round2(it.unitPrice) },
        amount: { before: before.amount, after: it.amount, delta: round2(it.amount - before.amount) },
      }))
    const previousPem = round2(prevItems.reduce((s, it) => s + it.amount, 0))
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
    'Calcula por codigo los importes de un presupuesto PROPUESTO (todavia no guardado en CERP): importe de cada partida, subtotales por capitulo, PEM, GG y BI sobre el PEM, PEC, un IVA y total. ' +
      'Usala antes de mostrar la tabla del plan o una diferencia entre versiones: NUNCA sumes ni calcules porcentajes de cabeza. ' +
      'Solo modela GG+BI sobre PEM y un unico impuesto: si el presupuesto tiene otro K, varios impuestos o retenciones, las cifras validas son las de CERP (get_budget_details o la vista previa de una tool de import). ' +
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
