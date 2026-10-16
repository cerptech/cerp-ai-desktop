import { useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight, FileText, FileInput, RotateCw } from 'lucide-react'
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
  { id: 'A5', icon: FileText, description: 'Desde planos, mediciones o una descripción.' },
  { id: 'A1', icon: FileInput, description: 'Tu Excel o PDF, cargado con capítulos y partidas.' },
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
 * Tareas del inicio (F1c, rediseño «escribir primero»): debajo del cuadro de
 * mensaje, dos destacadas y el resto por familia en pestañas. El catálogo es
 * único (cerp-ai-service, con respaldo local) y llega ya filtrado al canal
 * desktop, agrupado por familia.
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
    <div className="flex w-full flex-col gap-4">
      {featured.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {featured.map(({ id, icon: Icon, description, prompt, family }) => {
            const { isPreparing, hasFailed, percent } = gateOf(prompt, toolsSetup)
            return (
              <button
                key={id}
                type="button"
                onClick={() => pick(prompt, family)}
                disabled={disabled || isPreparing}
                title={titleOf(prompt)}
                className="flex items-center gap-3 rounded-[14px] border border-composer-border bg-white px-3.5 py-3 text-left outline-none transition-colors hover:border-primary-200 hover:bg-orange-50/40 focus-visible:ring-2 focus-visible:ring-brand-orange/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-primary-50 text-primary-600">
                  {isPreparing ? <LoadingSpinner size="sm" /> : <Icon className="size-[17px]" strokeWidth={2} aria-hidden="true" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-brand-black">{prompt.title}</span>
                  {isPreparing ? (
                    <span className="text-xs text-slate-500">Preparando herramientas… {percent}%</span>
                  ) : hasFailed ? (
                    <span className="text-xs text-error">No disponible · Reintentar</span>
                  ) : (
                    <span className="text-xs leading-[17px] text-[#52525b]">{description}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {current && (
        <section aria-label="Más tareas" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {tabs.map(({ family }) => {
              const selected = family.id === current.family.id
              return (
                <button
                  key={family.id}
                  type="button"
                  onClick={() => setSelectedId(family.id)}
                  aria-pressed={selected}
                  className={`h-[30px] rounded-full border px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
                    selected
                      ? 'border-primary-200 bg-primary-50 font-semibold text-primary-800'
                      : 'border-composer-border bg-white font-medium text-[#3f3f46] hover:bg-black/5'
                  }`}
                >
                  {family.title}
                </button>
              )
            })}
          </div>
          <div className="flex flex-col overflow-hidden rounded-[14px] border border-composer-border">
            {current.prompts.map((prompt) => {
              const { isPreparing, hasFailed } = gateOf(prompt, toolsSetup)
              return (
                <button
                  key={prompt.id}
                  type="button"
                  onClick={() => pick(prompt, current.family)}
                  disabled={disabled || isPreparing}
                  title={titleOf(prompt)}
                  className="group flex min-h-[46px] items-center gap-2.5 border-b border-[#f1f1f1] bg-white px-3.5 text-left text-[13.5px] text-brand-black outline-none transition-colors last:border-b-0 hover:bg-orange-50/40 focus-visible:bg-orange-50/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex-1">{prompt.title}</span>
                  {isPreparing ? (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500">
                      <LoadingSpinner size="sm" />
                      Preparando…
                    </span>
                  ) : hasFailed ? (
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-error">
                      <RotateCw className="size-3.5" strokeWidth={2} aria-hidden="true" />
                      Reintentar
                    </span>
                  ) : prompt.attachment === 'required' ? (
                    <span className="text-[11.5px] text-slate-500">Usa archivos</span>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0 text-slate-300 transition-colors group-hover:text-primary-600" strokeWidth={2} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
