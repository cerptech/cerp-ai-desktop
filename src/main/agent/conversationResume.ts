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
 * ellos; (2) los dos últimos mensajes del agente (donde suele estar la tabla del
 * presupuesto) no se cortan a 4000; (3) si falta algo, el agente lo dice en vez de
 * reconstruirlo.
 */

export type HistoryMessage = { role: 'user' | 'assistant'; content: string }

const ATTACHMENT_LINE = /^\[Archivo adjunto: (.+)\]$/gm
const DEFAULT_CAP = 4000
// Una tabla de presupuesto de ~80 partidas en markdown ronda los 15-20k caracteres.
const RECENT_ASSISTANT_CAP = 30000
const RECENT_ASSISTANT_COUNT = 2

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

  // Índices de los últimos mensajes del agente, que se conservan más largos.
  const recentAssistant = new Set<number>()
  for (let i = history.length - 1; i >= 0 && recentAssistant.size < RECENT_ASSISTANT_COUNT; i--) {
    if (history[i].role === 'assistant') recentAssistant.add(i)
  }

  let block = `

## HISTORIAL DE LA CONVERSACION ACTUAL

Esta sesion del SDK acaba de iniciarse pero la conversacion con el usuario ya tiene contexto previo. Estos son los mensajes anteriores entre el usuario y vos (el agente). Usalos como contexto para continuar coherente:

`
  history.forEach((msg, i) => {
    const speaker = msg.role === 'user' ? '**Usuario**' : '**Agente (vos)**'
    const cap = recentAssistant.has(i) ? RECENT_ASSISTANT_CAP : DEFAULT_CAP
    block += `\n${speaker}:\n${truncate(msg.content, cap)}\n\n---\n`
  })

  const attachments = extractAttachmentPaths(history)
  if (attachments.length > 0) {
    block += `

## ADJUNTOS DE ESTA CONVERSACION — VOLVE A LEERLOS

En esta sesion NO tenes el contenido de estos archivos: solo sus rutas. Lo que leiste de ellos en sesiones anteriores (cotas, mediciones, marcas, precios) NO esta en tu contexto.

${attachments.map((p) => `- ${p} — ${fileExists(p) ? 'disponible' : 'NO ENCONTRADO en el equipo'}`).join('\n')}

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
