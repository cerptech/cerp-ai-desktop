import type { ConversationFull } from '../../../preload/index'

// Rango Unicode de marcas diacríticas combinantes (acentos sueltos tras NFD).
const DIACRITICS_RE = /[̀-ͯ]/g

/** Nombre de archivo seguro: sin caracteres especiales de FS, espacios -> guiones. */
export function sanitizeFileName(name: string): string {
  const safe = name
    .normalize('NFD').replace(DIACRITICS_RE, '') // quita acentos
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return safe || 'conversacion'
}

function formatDateTime(value: string | number): string {
  return new Date(value).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const TOOL_STATUS_LABEL: Record<string, string> = {
  done: 'ok',
  error: 'error',
  running: 'interrumpida',
}

/**
 * Arma el Markdown de una conversación completa: título, fecha, y cada mensaje con
 * sus tools resumidas como notas breves (no el detalle técnico completo — es un
 * export para compartir/archivar, no un dump de debug).
 */
export function buildConversationMarkdown(conversation: ConversationFull): string {
  const lines: string[] = []

  lines.push(`# ${conversation.title}`)
  lines.push('')
  lines.push(`_Agente: ${conversation.agentName} · Exportado el ${formatDateTime(Date.now())}_`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of conversation.messages) {
    const who = msg.role === 'user' ? 'Usuario' : 'CERP AI'
    lines.push(`## ${who} — ${formatDateTime(msg.timestamp)}`)
    lines.push('')

    if (msg.content?.trim()) {
      lines.push(msg.content.trim())
      lines.push('')
    }

    if (msg.tools && msg.tools.length > 0) {
      lines.push('**Acciones ejecutadas:**')
      for (const tool of msg.tools) {
        const label = TOOL_STATUS_LABEL[tool.status] ?? tool.status
        const agentSuffix = tool.agentName ? ` (${tool.agentName})` : ''
        lines.push(`- ${tool.name}${agentSuffix} — ${label}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
