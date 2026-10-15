import { logger } from './logger'

/**
 * Biblioteca de prompts preparados (F1c) — la sirve cerp-ai-service, un catálogo
 * único para web y Desktop (ADR 017). Es público y no lleva datos de la empresa:
 * se pide SIN token. Si falla (red, timeout, staging detrás de Vercel Auth que
 * responde 302), el renderer usa su copia local empaquetada.
 */

export type PromptAttachment = 'required' | 'optional' | 'none'

export interface PromptLibraryPrompt {
  id: string
  title: string
  prompt: string
  fields: string[]
  attachment: PromptAttachment
  requiresTools?: boolean
}

export interface PromptLibraryFamily {
  id: string
  title: string
  prompts: PromptLibraryPrompt[]
}

export interface PromptLibraryResponse {
  version: string
  channel: string
  families: PromptLibraryFamily[]
}

const DEFAULT_AI_SERVICE_URL = 'https://cerp-ai-service.vercel.app'
const FETCH_TIMEOUT_MS = 3000

/** Mismo mecanismo que la URL del core (`CERP_API_BASE_URL` en httpClient.ts). */
export function getAiServiceUrl(): string {
  return (process.env.CERP_AI_SERVICE_URL || DEFAULT_AI_SERVICE_URL).replace(/\/+$/, '')
}

const ATTACHMENTS: readonly PromptAttachment[] = ['required', 'optional', 'none']

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Valida la forma del contrato; descarta lo que no encaje en vez de romper la UI. */
export function parsePromptLibrary(raw: unknown): PromptLibraryResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.families)) return null
  const families: PromptLibraryFamily[] = []
  for (const f of r.families as unknown[]) {
    if (!f || typeof f !== 'object') continue
    const fam = f as Record<string, unknown>
    if (!isString(fam.id) || !isString(fam.title) || !Array.isArray(fam.prompts)) continue
    const prompts: PromptLibraryPrompt[] = []
    for (const p of fam.prompts as unknown[]) {
      if (!p || typeof p !== 'object') continue
      const pr = p as Record<string, unknown>
      if (!isString(pr.id) || !isString(pr.title) || !isString(pr.prompt)) continue
      prompts.push({
        id: pr.id,
        title: pr.title,
        prompt: pr.prompt,
        fields: Array.isArray(pr.fields) ? (pr.fields as unknown[]).filter(isString) : [],
        attachment: ATTACHMENTS.includes(pr.attachment as PromptAttachment) ? (pr.attachment as PromptAttachment) : 'none',
        ...(pr.requiresTools === true ? { requiresTools: true } : {}),
      })
    }
    if (prompts.length) families.push({ id: fam.id, title: fam.title, prompts })
  }
  if (!families.length) return null
  return {
    version: isString(r.version) ? r.version : String(r.version ?? ''),
    channel: isString(r.channel) ? r.channel : 'desktop',
    families,
  }
}

// Cache en memoria por sesión de la app: solo se guarda un resultado válido; un
// fallo no se cachea (el próximo chat vacío lo reintenta) pero sí se deduplica
// la petición en vuelo.
let cached: PromptLibraryResponse | null = null
let inFlight: Promise<PromptLibraryResponse | null> | null = null

export async function getPromptLibrary(): Promise<PromptLibraryResponse | null> {
  if (cached) return cached
  if (inFlight) return inFlight
  inFlight = (async () => {
    const url = `${getAiServiceUrl()}/api/prompt-library?channel=desktop`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      // redirect 'error': staging responde 302 al login de Vercel; seguirlo
      // devolvería HTML. Mejor fallar rápido y usar el respaldo local.
      const res = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } })
      if (!res.ok) {
        logger.warn(`prompt-library: HTTP ${res.status} — se usa el respaldo local`)
        return null
      }
      const parsed = parsePromptLibrary(await res.json())
      if (!parsed) {
        logger.warn('prompt-library: respuesta sin el formato esperado — se usa el respaldo local')
        return null
      }
      cached = parsed
      return parsed
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`prompt-library: no disponible (${message}) — se usa el respaldo local`)
      return null
    } finally {
      clearTimeout(timer)
      inFlight = null
    }
  })()
  return inFlight
}
