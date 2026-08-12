/**
 * Genera un título legible a partir del primer prompt del usuario.
 *
 * Antes se usaba `prompt.slice(0, 50)` a secas — cortaba palabras a la mitad y
 * arrastraba saltos de línea sueltos si el usuario pegaba texto multilínea. Esta
 * versión colapsa espacios/saltos de línea, corta en el último espacio antes del
 * límite (para no partir una palabra) y capitaliza la primera letra.
 *
 * El título generado por IA (resumen real del tema) queda para otra iteración —
 * esto es solo una mejora barata sobre el slice anterior.
 */
const MAX_TITLE_LEN = 60
// Si el corte por espacio cae muy temprano (palabra larga sin espacios al inicio),
// preferimos un corte duro antes que un título de 3 caracteres.
const MIN_BREAK_LEN = 20

export function buildConversationTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'Nueva conversación'

  let title = cleaned
  if (cleaned.length > MAX_TITLE_LEN) {
    const truncated = cleaned.slice(0, MAX_TITLE_LEN)
    const lastSpace = truncated.lastIndexOf(' ')
    title = `${lastSpace > MIN_BREAK_LEN ? truncated.slice(0, lastSpace) : truncated}…`
  }

  return title.charAt(0).toUpperCase() + title.slice(1)
}
