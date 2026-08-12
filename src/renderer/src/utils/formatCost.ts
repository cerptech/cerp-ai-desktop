/**
 * Formatea un costo en USD estilo es-ES (coma decimal) con 3 decimales — el costo de
 * una conversación suele ser fracciones de centavo, con 2 decimales redondearía casi
 * todo a "$0,00". Ej: 0.0421 → "$0,042".
 */
export function formatSessionCost(usd: number): string {
  return `$${usd.toFixed(3).replace('.', ',')}`
}
