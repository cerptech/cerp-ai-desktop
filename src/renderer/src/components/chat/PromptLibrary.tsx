import { useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { FileText, FileInput, FolderOpen, RotateCw } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import type { PromptLibraryFamily, PromptLibraryPrompt } from '@/lib/promptLibrary'

interface ToolsSetupInfo {
  ready: boolean
  preparing: boolean
  status: 'idle' | 'checking' | 'installing' | 'ready' | 'error'
  percent: number
  retry: () => void
}

interface PromptLibraryProps {
  families: PromptLibraryFamily[]
  /** Carga el prompt en el composer (ya NO lo envía: el usuario completa los [campos]). */
  onSelect: (prompt: PromptLibraryPrompt, family: PromptLibraryFamily) => void
  disabled?: boolean
  /** Estado de Git/Python (Ola 3) — gatea los prompts con `requiresTools`. */
  toolsSetup?: ToolsSetupInfo
}

/**
 * Las dos tareas destacadas del inicio, por id del catálogo. La descripción es
 * propia de la tarjeta (el catálogo no la trae); si el catálogo deja de ofrecer
 * un id, su tarjeta simplemente no se muestra.
 */
const FEATURED: { id: string; icon: LucideIcon; description: string }[] = [
  { id: 'A5', icon: FileText, description: 'A partir de planos, mediciones o una descripción del trabajo.' },
  { id: 'A1', icon: FileInput, description: 'Lee tu Excel o PDF y lo carga en CERP con capítulos y partidas.' },
]

/** Estado de un prompt que necesita Git/Python mientras se preparan. */
function gateOf(prompt: PromptLibraryPrompt, toolsSetup?: ToolsSetupInfo) {
  const gated = !!prompt.requiresTools && !!toolsSetup && !toolsSetup.ready
  return {
    isPreparing: gated && toolsSetup!.preparing,
    hasFailed: gated && toolsSetup!.status === 'error',
    percent: toolsSetup ? Math.round(toolsSetup.percent) : 0,
  }
}

/**
 * Inicio del chat (F1c, rediseño): dos tareas destacadas y «Más tareas» por
 * familia en pestañas. El catálogo es único (cerp-ai-service, con respaldo
 * local) y llega ya filtrado al canal desktop, agrupado por familia.
 */
export function PromptLibrary({ families, onSelect, disabled, toolsSetup }: PromptLibraryProps) {
  const featured = useMemo(
    () =>
      FEATURED.flatMap((f) => {
        for (const family of families) {
          const prompt = family.prompts.find((p) => p.id === f.id)
          if (prompt) return [{ ...f, prompt, family }]
        }
        return []
      }),
    [families],
  )

  const featuredIds = useMemo(() => new Set(featured.map((f) => f.id)), [featured])
  const tabs = useMemo(
    () =>
      families
        .map((family) => ({ family, prompts: family.prompts.filter((p) => !featuredIds.has(p.id)) }))
        .filter((t) => t.prompts.length > 0),
    [families, featuredIds],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const current = tabs.find((t) => t.family.id === selectedId) ?? tabs[0]

  const pick = (prompt: PromptLibraryPrompt, family: PromptLibraryFamily) => {
    const { isPreparing, hasFailed } = gateOf(prompt, toolsSetup)
    if (hasFailed) { toolsSetup!.retry(); return }
    if (isPreparing) return
    onSelect(prompt, family)
  }

  const titleOf = (prompt: PromptLibraryPrompt) => {
    const { isPreparing, hasFailed, percent } = gateOf(prompt, toolsSetup)
    if (isPreparing) return `Preparando herramientas… ${percent}%`
    if (hasFailed) return 'No se pudieron preparar las herramientas necesarias. Haz clic para reintentar.'
    return prompt.prompt
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {featured.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {featured.map(({ id, icon: Icon, description, prompt, family }) => {
            const { isPreparing, hasFailed, percent } = gateOf(prompt, toolsSetup)
            return (
              <button
                key={id}
                type="button"
                onClick={() => pick(prompt, family)}
                disabled={disabled || isPreparing}
                title={titleOf(prompt)}
                className="flex flex-col items-start gap-2.5 rounded-2xl border border-composer-border bg-white p-[18px] text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none transition-colors hover:border-brand-orange/40 hover:bg-orange-50/40 focus-visible:ring-2 focus-visible:ring-brand-orange/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex size-9 items-center justify-center rounded-[10px] bg-primary-50 text-primary-600">
                  {isPreparing ? <LoadingSpinner size="sm" /> : <Icon className="size-[18px]" strokeWidth={2} aria-hidden="true" />}
                </span>
                <span className="text-[15px] font-semibold text-brand-black">{prompt.title}</span>
                <span className="text-[13px] leading-[19px] text-[#52525b]">{description}</span>
                {isPreparing ? (
                  <span className="text-[11.5px] text-slate-500">Preparando herramientas… {percent}%</span>
                ) : hasFailed ? (
                  <span className="text-[11.5px] text-error">No disponible · Reintentar</span>
                ) : prompt.attachment === 'required' ? (
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500">
                    <FolderOpen className="size-3" strokeWidth={2} aria-hidden="true" />
                    Usa los archivos de tu carpeta
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}

      {current && (
        <section aria-label="Más tareas" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[11px] font-semibold tracking-[0.08em] text-slate-500">MÁS TAREAS</span>
            {tabs.map(({ family }) => {
              const selected = family.id === current.family.id
              return (
                <button
                  key={family.id}
                  type="button"
                  onClick={() => setSelectedId(family.id)}
                  aria-pressed={selected}
                  className={`h-[30px] rounded-full border px-3 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
                    selected
                      ? 'border-brand-black bg-brand-black text-white'
                      : 'border-composer-border bg-white text-[#3f3f46] hover:bg-black/5'
                  }`}
                >
                  {family.title}
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {current.prompts.map((prompt) => {
              const { isPreparing, hasFailed } = gateOf(prompt, toolsSetup)
              return (
                <button
                  key={prompt.id}
                  type="button"
                  onClick={() => pick(prompt, current.family)}
                  disabled={disabled || isPreparing}
                  title={titleOf(prompt)}
                  className="flex min-h-11 items-center justify-between gap-2.5 rounded-xl border border-sidebar-border bg-sidebar px-3.5 text-left text-[13px] text-brand-black outline-none transition-colors hover:border-brand-orange/40 hover:bg-orange-50/40 focus-visible:ring-2 focus-visible:ring-brand-orange/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span>{prompt.title}</span>
                  {isPreparing ? (
                    <LoadingSpinner size="sm" />
                  ) : hasFailed ? (
                    <RotateCw className="size-3.5 shrink-0 text-error" strokeWidth={2} aria-label="No disponible, reintentar" />
                  ) : prompt.attachment === 'required' ? (
                    <FolderOpen className="size-3.5 shrink-0 text-slate-400" strokeWidth={2} aria-label="Usa los archivos de tu carpeta" />
                  ) : null}
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
