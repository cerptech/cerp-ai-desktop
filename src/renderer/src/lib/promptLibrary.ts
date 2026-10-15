import type { PromptLibraryFamily, PromptLibraryPrompt, PromptLibraryResponse, PromptAttachment } from '../../../main/utils/promptLibrary'
import fallbackCatalog from '@/constants/promptCatalog.fallback.json'

export type { PromptLibraryFamily, PromptLibraryPrompt, PromptLibraryResponse, PromptAttachment }

/** Forma del catálogo completo (la del respaldo local): cada prompt declara sus canales. */
export interface CatalogPrompt {
  id: string
  title: string
  prompt: string
  channels: string[]
  fields?: string[]
  attachment?: string
  requiresTools?: boolean
}

export interface CatalogFamily {
  id: string
  title: string
  prompts: CatalogPrompt[]
}

export interface PromptCatalog {
  version: string
  families: CatalogFamily[]
}

export const DESKTOP_CHANNEL = 'desktop'

const FIELD_RE = /\[([^\]]+)\]/g

/** `[campos]` del prompt, en orden y sin repetir. */
export function extractFields(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(FIELD_RE)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Rango del primer `[campo]` (corchetes incluidos) para seleccionarlo en el composer. */
export function findFirstField(text: string): { start: number; end: number } | null {
  const m = /\[[^\]]+\]/.exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

function toAttachment(value: string | undefined): PromptAttachment {
  return value === 'required' || value === 'optional' ? value : 'none'
}

/**
 * Filtra el catálogo completo a un canal: solo los prompts cuyo `channels` lo
 * incluye, y fuera las familias que quedan vacías. Mismo contrato que devuelve
 * `GET /api/prompt-library?channel=…` de cerp-ai-service.
 */
export function filterCatalogForChannel(catalog: PromptCatalog, channel: string): PromptLibraryResponse {
  const families: PromptLibraryFamily[] = []
  for (const family of catalog.families) {
    const prompts = family.prompts
      .filter((p) => Array.isArray(p.channels) && p.channels.includes(channel))
      .map((p) => ({
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        fields: Array.isArray(p.fields) ? p.fields : extractFields(p.prompt),
        attachment: toAttachment(p.attachment),
        ...(p.requiresTools ? { requiresTools: true } : {}),
      }))
    if (prompts.length) families.push({ id: family.id, title: family.title, prompts })
  }
  return { version: catalog.version, channel, families }
}

/** Respaldo empaquetado, ya filtrado al canal desktop. */
export function getFallbackLibrary(): PromptLibraryResponse {
  return filterCatalogForChannel(fallbackCatalog as PromptCatalog, DESKTOP_CHANNEL)
}

/** Usa la respuesta del servicio si trae al menos un prompt; si no, el respaldo. */
export function pickLibrary(remote: PromptLibraryResponse | null | undefined): PromptLibraryResponse {
  const hasPrompts = !!remote && remote.families.some((f) => f.prompts.length > 0)
  return hasPrompts ? remote! : getFallbackLibrary()
}
