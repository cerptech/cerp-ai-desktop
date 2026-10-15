import type { LucideIcon } from 'lucide-react'
import { FileSpreadsheet, CalendarClock, Receipt, Sparkles, FolderOpen, RotateCw } from 'lucide-react'
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

const FAMILY_ICONS: Record<string, LucideIcon> = {
  'budget-import': FileSpreadsheet,
  'project-dates': CalendarClock,
  'purchases-invoices': Receipt,
}

/**
 * Biblioteca de prompts preparados (F1c) — reemplaza a las quick actions fijas.
 * El catálogo es único (cerp-ai-service, con respaldo local) y llega ya filtrado
 * al canal desktop, agrupado por familia.
 */
export function PromptLibrary({ families, onSelect, disabled, toolsSetup }: PromptLibraryProps) {
  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-5">
      {families.map((family) => {
        const FamilyIcon = FAMILY_ICONS[family.id] ?? Sparkles
        return (
          <section key={family.id} aria-label={family.title}>
            <h3 className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <FamilyIcon className="size-3.5 text-brand-orange" strokeWidth={2} aria-hidden="true" />
              {family.title}
            </h3>
            <div className="grid grid-cols-2 gap-2.5">
              {family.prompts.map((prompt) => {
                const gated = prompt.requiresTools && toolsSetup && !toolsSetup.ready
                const isPreparing = !!gated && toolsSetup!.preparing
                const hasFailed = !!gated && toolsSetup!.status === 'error'

                return (
                  <button
                    key={prompt.id}
                    type="button"
                    onClick={() => {
                      if (hasFailed) { toolsSetup!.retry(); return }
                      if (isPreparing) return
                      onSelect(prompt, family)
                    }}
                    disabled={disabled || isPreparing}
                    title={
                      isPreparing
                        ? `Preparando herramientas… ${Math.round(toolsSetup!.percent)}%`
                        : hasFailed
                          ? 'No se pudieron preparar las herramientas necesarias. Haz clic para reintentar.'
                          : prompt.prompt
                    }
                    className="flex items-start gap-3 p-3.5 bg-white rounded-2xl border border-composer-border hover:border-brand-orange/40 hover:bg-orange-50/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed group"
                  >
                    {isPreparing ? (
                      <LoadingSpinner size="sm" />
                    ) : hasFailed ? (
                      <RotateCw className="size-4 mt-0.5 shrink-0 text-error" strokeWidth={2} aria-hidden="true" />
                    ) : null}
                    <div className="min-w-0">
                      <span className="block text-sm font-medium text-slate-700 group-hover:text-slate-900">
                        {prompt.title}
                      </span>
                      {isPreparing ? (
                        <span className="block text-[11px] text-slate-400 mt-0.5">
                          Preparando herramientas… {Math.round(toolsSetup!.percent)}%
                        </span>
                      ) : hasFailed ? (
                        <span className="block text-[11px] text-error mt-0.5">No disponible · Reintentar</span>
                      ) : prompt.attachment === 'required' ? (
                        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
                          <FolderOpen className="size-3" strokeWidth={2} aria-hidden="true" />
                          Usa los archivos de tu carpeta de trabajo
                        </span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
