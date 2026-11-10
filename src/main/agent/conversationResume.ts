import { existsSync } from 'node:fs'

/**
 * Retomar una conversación en una sesión nueva del SDK.
 *
 * El SDK no guarda nada entre sesiones: el historial vuelve como texto en el prompt
 * de sistema. Hasta v1.0.45 cada mensaje se cortaba a 4000 caracteres y los adjuntos
 * eran solo la línea `[Archivo adjunto: ruta]`, sin ninguna instrucción. En el caso
 * Cresata (26-10) el agente retomó un presupuesto sin volver a leer los planos y lo
 * rehízo «de memoria»: perdió partidas y el total bajó un 15 %.
 *
 * Ahora: (1) los adjuntos de toda la conversación se listan aparte, con su estado
 * en disco, y se exige volver a leerlos antes de usar cualquier dato que salga de
 * ellos; (2) el último mensaje del agente y el último con una tabla (el presupuesto)
 * no se cortan a 4000; (3) el historial tiene un tope total; (4) si falta algo, el
 * agente lo dice en vez de reconstruirlo.
 */

export type HistoryMessage = { role: 'user' | 'assistant'; content: string }

const ATTACHMENT_LINE = /^\[Archivo adjunto: (.+)\]$/gm
const DEFAULT_CAP = 4000
// Una tabla de presupuesto de ~80 partidas en markdown ronda los 15-20k caracteres.
const KEPT_ASSISTANT_CAP = 30000
// Tope del historial completo: se recortan primero los mensajes más antiguos.
const TOTAL_HISTORY_CAP = 120000
const TABLE_LINE = /^\s*\|.*\|\s*$/m

/**
 * Solo se mira en disco una ruta local absoluta (C:\… o /…). Nunca UNC (\\host\share):
 * el texto sale del historial, y un stat sobre UNC dispara autenticación SMB y puede
 * bloquear el proceso main con una unidad de red caída.
 */
export function isLocalAbsolutePath(p: string): boolean {
  if (p.startsWith('\\\\') || p.startsWith('//')) return false
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')
}

function attachmentStatus(p: string, fileExists: (path: string) => boolean): string {
  if (!isLocalAbsolutePath(p)) return 'ruta de red o no local: si hace falta, pedir al usuario que lo adjunte de nuevo'
  return fileExists(p) ? 'disponible' : 'NO ENCONTRADO en el equipo'
}

export function extractAttachmentPaths(history: HistoryMessage[]): string[] {
  const paths = new Set<string>()
  for (const msg of history) {
    if (msg.role !== 'user') continue
    for (const m of msg.content.matchAll(ATTACHMENT_LINE)) paths.add(m[1].trim())
  }
  return [...paths]
}

function truncate(content: string, cap: number): string {
  return content.length > cap ? content.slice(0, cap) + '\n\n[...mensaje truncado...]' : content
}

export function buildHistoryBlock(
  history: HistoryMessage[],
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (history.length === 0) return ''

  // Se conservan largos: el último mensaje del agente, y el último que tenga una tabla
  // (el presupuesto suele estar ahí aunque después vinieran un par de «¿Confirmás?»).
  const kept = new Set<number>()
  const lastAssistant = history.map((m) => m.role).lastIndexOf('assistant')
  if (lastAssistant >= 0) kept.add(lastAssistant)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && TABLE_LINE.test(history[i].content)) {
      kept.add(i)
      break
    }
  }

  const rendered = history.map((msg, i) => {
    const speaker = msg.role === 'user' ? '**Usuario**' : '**Agente (vos)**'
    const cap = kept.has(i) ? KEPT_ASSISTANT_CAP : DEFAULT_CAP
    return `\n${speaker}:\n${truncate(msg.content, cap)}\n\n---\n`
  })
  // Tope total: se descartan los mensajes más antiguos (nunca los conservados).
  let size = rendered.reduce((s, r) => s + r.length, 0)
  let omitted = 0
  for (let i = 0; i < rendered.length && size > TOTAL_HISTORY_CAP; i++) {
    if (kept.has(i)) continue
    size -= rendered[i].length
    rendered[i] = ''
    omitted++
  }

  let block = `

## HISTORIAL DE LA CONVERSACION ACTUAL

Esta sesion del SDK acaba de iniciarse pero la conversacion con el usuario ya tiene contexto previo. Estos son los mensajes anteriores entre el usuario y vos (el agente). Usalos como contexto para continuar coherente:

`
  if (omitted > 0) block += `\n[${omitted} mensajes antiguos omitidos por longitud]\n`
  block += rendered.join('')

  const attachments = extractAttachmentPaths(history)
  if (attachments.length > 0) {
    block += `

## ADJUNTOS DE ESTA CONVERSACION — VOLVE A LEERLOS

En esta sesion NO tenes el contenido de estos archivos: solo sus rutas. Lo que leiste de ellos en sesiones anteriores (cotas, mediciones, marcas, precios) NO esta en tu contexto.

${attachments.map((p) => `- ${p} — ${attachmentStatus(p, fileExists)}`).join('\n')}

Reglas:
- Antes de usar cualquier dato que salga de un adjunto (mediciones, cotas, partidas, productos especificados), volve a leerlo con Read o delegalo al subagente que corresponda. No lo reconstruyas a partir de lo que dice el historial.
- Si un adjunto figura como NO ENCONTRADO, decíselo al usuario y pedile que lo vuelva a adjuntar. No sigas con supuestos.
`
  }

  block += `

## COMO RETOMAR SIN PERDER NADA

- Si en esta conversacion ya se creo un presupuesto en CERP, traelo completo con \`get_budget_details\` y \`get_budget_items\` antes de modificarlo o compararlo. El presupuesto de CERP es la fuente de verdad, no tu memoria.
- Si el presupuesto solo existe como tabla en el historial y esta truncada o incompleta, decilo: "No tengo el presupuesto anterior completo". No lo rehagas de memoria.
- Si el usuario te pide reformular, partí del presupuesto anterior completo y mostrá que partidas se añaden, cuales se quitan y cuales cambian (ver la regla de REFORMULAR).

Continua la conversacion respondiendo al ULTIMO mensaje del usuario teniendo en cuenta TODO lo que paso antes. Si el usuario dice algo como "confirmo" o "si" o "dale", interpretalo en el contexto del plan / pregunta inmediatamente anterior — NO le digas "no tengo contexto".
`
  return block
}
