/**
 * Tarjeta de confirmación de una acción en una app conectada (Composio).
 *
 * ⚠️ ESPEJO de `describeAppAction` / `toolkitDisplayName` en
 * `cerp-ai-service/lib/agents/appTools.ts` (canal web). No hay paquete
 * compartido entre repos: si cambiás uno, cambiá el otro.
 *
 * Lo que NO se copia es el `writeGuard` (qué acción escribe): eso lo decide el
 * core, que lo devuelve en `necesitaConfirmacion` (get_app_tool_schema) y lo
 * vuelve a exigir con 403 al ejecutar. Acá solo se redacta lo que el usuario ve.
 *
 * La tarjeta se arma con el INPUT REAL que se va a ejecutar, nunca con texto del
 * modelo: si una inyección dentro de un email logra cambiar el destinatario, el
 * destinatario cambiado es el que se ve en pantalla.
 */

/** Slugs que además BORRAN algo: la tarjeta los marca como destructivos. */
const DESTRUCTIVE_VERB = /_(DELETE|REMOVE|ARCHIVE)_/

export interface AppActionCard {
  title: string
  fields: Array<{ label: string; value: string }>
  preview?: string
  destructive: boolean
  toolkit: string
}

/** Nombre legible de la app a partir del slug del toolkit. */
const TOOLKIT_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledrive: 'Google Drive',
  googlesheets: 'Google Sheets',
  outlook: 'Outlook',
  onedrive: 'OneDrive',
  microsoftteams: 'Microsoft Teams',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  notion: 'Notion',
}

export function toolkitDisplayName(slug: string): string {
  const key = (slug ?? '').toLowerCase()
  return TOOLKIT_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'la app')
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value) && value.length > 0) {
    const joined = value.filter((v) => typeof v === 'string').join(', ')
    return joined || undefined
  }
  return undefined
}

export function describeAppAction(slug: string, input: Record<string, unknown>, toolkit: string): AppActionCard {
  const upper = (slug ?? '').toUpperCase()
  const appName = toolkitDisplayName(toolkit)
  const fields: Array<{ label: string; value: string }> = []
  let preview: string | undefined
  let title = `Ejecutar ${slug} en ${appName}`

  const to = str(input.recipient_email) ?? str(input.to) ?? str(input.to_recipients)
  const subject = str(input.subject)
  const body = str(input.body) ?? str(input.message) ?? str(input.text)

  if (upper.includes('SEND_EMAIL') || upper.includes('CREATE_EMAIL_DRAFT') || upper.includes('REPLY')) {
    title = upper.includes('DRAFT') ? `Crear un borrador en ${appName}` : `Enviar un email desde ${appName}`
    if (to) fields.push({ label: 'Para', value: to })
    if (subject) fields.push({ label: 'Asunto', value: subject })
    preview = body
  } else if (upper.includes('CREATE_EVENT')) {
    title = `Crear un evento en ${appName}`
    const summary = str(input.summary) ?? str(input.title)
    if (summary) fields.push({ label: 'Evento', value: summary })
    const start = str(input.start_datetime) ?? str(input.start_time) ?? str(input.start)
    if (start) fields.push({ label: 'Inicio', value: start })
    const attendees = str(input.attendees)
    if (attendees) fields.push({ label: 'Invitados', value: attendees })
    preview = str(input.description)
  } else if (upper.includes('UPLOAD')) {
    title = `Subir un archivo a ${appName}`
    const fileName = str(input.file_name) ?? str(input.name)
    if (fileName) fields.push({ label: 'Archivo', value: fileName })
  } else if (upper.includes('SEND_MESSAGE')) {
    title = `Enviar un mensaje por ${appName}`
    const dest = to ?? str(input.channel) ?? str(input.phone_number)
    if (dest) fields.push({ label: 'Para', value: dest })
    preview = body
  } else {
    // Fallback genérico: los primeros campos del input tal cual, para que el
    // usuario vea con qué se va a ejecutar aunque no haya formateador para esta app.
    for (const [key, value] of Object.entries(input).slice(0, 4)) {
      const v = str(value)
      if (v) fields.push({ label: key, value: v })
    }
  }

  return {
    title,
    fields,
    preview: preview ? preview.slice(0, 2000) : undefined,
    destructive: DESTRUCTIVE_VERB.test(`${upper}_`),
    toolkit,
  }
}
