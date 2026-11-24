/**
 * Unidades del ledger de créditos → créditos que ve el usuario.
 *
 * El core guarda el saldo en unidades enteras (los campos `*Hundredths`) y
 * manda en la misma respuesta `unitsPerCredit`: cuántas unidades son un
 * crédito para ESA empresa. Hoy vale 100; puede valer 10 (escala ×10 de
 * créditos, plan docs/plans/modelo-negocio-2026-11 del repo de config).
 *
 * El Desktop NUNCA decide el divisor ni lee flags: usa el que manda el core y,
 * si no viene (core anterior al cambio) o no es un número positivo, 100, que es
 * exactamente el comportamiento de siempre.
 */
export const DEFAULT_UNITS_PER_CREDIT = 100

/** Primer candidato que sea un número finito > 0; si ninguno lo es, 100. */
export function resolveUnitsPerCredit(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
  }
  return DEFAULT_UNITS_PER_CREDIT
}

/** Unidades → créditos con el divisor que mandó el core. */
export function unitsToCredits(units: number, unitsPerCredit: number): number {
  return units / unitsPerCredit
}
