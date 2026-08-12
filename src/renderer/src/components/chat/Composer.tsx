import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  Mic,
  Plus,
  Rabbit,
  Sparkles,
  Brain,
  Square,
  Upload,
  X,
  Zap,
  ClipboardCheck,
} from 'lucide-react'
import type { ModelChoice } from '@/hooks/useModelChoice'
import type { DictationStatus } from '@/hooks/useDictation'
import type { AttachmentFile } from '@/hooks/useAttachments'
import { AttachmentCard } from './AttachmentCard'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  /** Turno en curso: el botón de enviar pasa a ser "detener". */
  streaming?: boolean
  onStop?: () => void
  attachments: AttachmentFile[]
  onRemoveAttachment: (path: string) => void
  attachmentsMaxed: boolean
  onSelectAttachments: () => void
  dictationStatus: DictationStatus
  onDictate: () => void
  modelChoice: ModelChoice
  onModelChange: (choice: ModelChoice) => void
  modelSelectorDisabled?: boolean
  planMode: boolean
  onTogglePlanMode: () => void
  turboMode: boolean
  onToggleTurboMode: () => void
  cwd: string | null
  onSelectFolder: () => void
  onClearFolder: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

const MODEL_OPTIONS: Array<{ value: ModelChoice; label: string; hint: string; icon: typeof Sparkles }> = [
  { value: 'auto', label: 'Auto', hint: 'El modelo recomendado según tu plan', icon: Sparkles },
  { value: 'fast', label: 'Rápido', hint: 'Respuestas más rápidas, para consultas simples', icon: Rabbit },
  { value: 'powerful', label: 'Potente', hint: 'Máximo razonamiento, para tareas complejas', icon: Brain },
]

/**
 * Composer — converge con el patrón de ai.cerp.es (Composer.tsx): contenedor
 * blanco rounded-3xl, fila inferior de controles agrupada. Reemplaza a los 5+
 * controles sueltos que tenía ChatContainer (adjuntar, dictado, carpeta,
 * selector de modelo, Modo plan, Turbo, enviar/detener): ahora "+" agrupa
 * adjuntar/carpeta, Modo plan y Turbo son pills, y a la derecha quedan
 * modelo + micrófono + enviar/detener.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder,
  streaming = false,
  onStop,
  attachments,
  onRemoveAttachment,
  attachmentsMaxed,
  onSelectAttachments,
  dictationStatus,
  onDictate,
  modelChoice,
  onModelChange,
  modelSelectorDisabled,
  planMode,
  onTogglePlanMode,
  turboMode,
  onToggleTurboMode,
  cwd,
  onSelectFolder,
  onClearFolder,
  textareaRef,
}: ComposerProps) {
  const [openMenu, setOpenMenu] = useState<'attach' | 'model' | null>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  const canSend = Boolean(value.trim()) || attachments.length > 0

  useEffect(() => {
    if (!openMenu) return
    const handleClickOutside = (e: MouseEvent): void => {
      const ref = openMenu === 'attach' ? attachMenuRef : modelMenuRef
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenMenu(null)
    }
    const handleEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [openMenu])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && canSend) onSubmit()
      return
    }
    if (e.key === 'Escape') {
      if (streaming) onStop?.()
      else if (value.trim()) onChange('')
    }
  }

  // Auto-grow hasta 160px, igual patrón que ai.cerp.es — se recalcula ante
  // cualquier cambio de `value`, no solo al teclear (quick actions, dictado, etc).
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    if (value) el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value, textareaRef])

  const currentModel = MODEL_OPTIONS.find((o) => o.value === modelChoice) ?? MODEL_OPTIONS[0]
  const CurrentModelIcon = currentModel.icon

  return (
    <div className="w-full rounded-3xl border border-composer-border bg-white px-5 pb-[13px] pt-[18px] shadow-[0_4px_18px_rgba(16,24,40,0.05)]">
      {attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {attachments.map((a) => (
            <AttachmentCard key={a.path} attachment={a} onRemove={onRemoveAttachment} />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Pregunta lo que necesites…'}
        aria-label={placeholder ?? 'Pregunta lo que necesites'}
        disabled={disabled}
        className="max-h-40 min-h-[26px] w-full resize-none bg-transparent text-base leading-[1.45] text-brand-black outline-none placeholder:text-[#9aa1ad] disabled:text-slate-400"
      />

      <div className="mt-3.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
          {/* "+" agrupa adjuntar archivos y seleccionar carpeta de trabajo */}
          <div ref={attachMenuRef} className="relative shrink-0">
            <button
              type="button"
              title="Adjuntar"
              onClick={() => setOpenMenu(openMenu === 'attach' ? null : 'attach')}
              className="flex size-[33px] items-center justify-center rounded-full border border-composer-border bg-white text-[#44474d] outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-black/5 hover:text-brand-black"
            >
              <Plus className="size-[18px]" strokeWidth={2} aria-hidden="true" />
            </button>
            {openMenu === 'attach' && (
              <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-composer-border bg-white shadow-lg py-1.5 z-20">
                <button
                  type="button"
                  disabled={attachmentsMaxed}
                  onClick={() => {
                    setOpenMenu(null)
                    onSelectAttachments()
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Upload className="size-4 mt-0.5 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm text-slate-800">Adjuntar archivos</span>
                    <span className="text-xs text-muted-foreground text-slate-400">PDF, Excel, imágenes, DWG…</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null)
                    onSelectFolder()
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/5 transition-colors"
                >
                  <FolderOpen className="size-4 mt-0.5 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm text-slate-800">Carpeta de trabajo</span>
                    <span className="text-xs text-muted-foreground text-slate-400 truncate">
                      {cwd ? cwd.split(/[\\/]/).pop() : 'Sin seleccionar'}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Modo plan — pill toggle */}
          <button
            type="button"
            onClick={onTogglePlanMode}
            aria-pressed={planMode}
            title={planMode ? 'Modo plan activo — el agente solo planifica, no ejecuta' : 'Activar Modo plan'}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-[13px] py-[7px] text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
              planMode
                ? 'border-amber-300 bg-amber-100 text-amber-800'
                : 'border-composer-border bg-white text-[#3f434a] hover:bg-black/5 hover:text-brand-black'
            }`}
          >
            <ClipboardCheck className="size-4" strokeWidth={2} aria-hidden="true" />
            Modo plan
          </button>

          {/* Turbo — pill toggle */}
          <button
            type="button"
            onClick={onToggleTurboMode}
            aria-pressed={turboMode}
            title={turboMode ? 'Modo Turbo activo — máxima precisión, usa más recursos' : 'Activar Modo Turbo'}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-[13px] py-[7px] text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
              turboMode
                ? 'border-violet-300 bg-violet-100 text-violet-800'
                : 'border-composer-border bg-white text-[#3f434a] hover:bg-black/5 hover:text-brand-black'
            }`}
          >
            <Zap className="size-4" strokeWidth={2} aria-hidden="true" />
            Turbo
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Selector de modelo */}
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => !modelSelectorDisabled && setOpenMenu(openMenu === 'model' ? null : 'model')}
              disabled={modelSelectorDisabled}
              title={modelSelectorDisabled ? 'Modo Turbo activo — fija el modelo automáticamente' : `Modelo: ${currentModel.label}`}
              className={`inline-flex items-center gap-1.5 rounded-full py-1.5 pl-[7px] pr-[9px] text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 ${
                modelSelectorDisabled ? 'text-slate-300 cursor-not-allowed' : 'text-[#3f434a] hover:bg-black/5 hover:text-brand-black'
              }`}
            >
              <CurrentModelIcon className="size-4 text-brand-orange" strokeWidth={2} aria-hidden="true" />
              {currentModel.label}
              <ChevronDown className={`size-3.5 text-[#9aa1ad] transition-transform ${openMenu === 'model' ? 'rotate-180' : ''}`} strokeWidth={2} aria-hidden="true" />
            </button>
            {openMenu === 'model' && !modelSelectorDisabled && (
              <div className="absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-composer-border bg-white shadow-lg py-1.5 z-20">
                {MODEL_OPTIONS.map((option) => {
                  const Icon = option.icon
                  const isActive = option.value === modelChoice
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        onModelChange(option.value)
                        setOpenMenu(null)
                      }}
                      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-black/5 transition-colors"
                    >
                      <Icon className="size-4 mt-0.5 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm text-slate-800">{option.label}</span>
                        <span className="text-xs text-slate-400">{option.hint}</span>
                      </span>
                      {isActive && <Check className="ml-auto size-4 shrink-0 text-brand-orange" strokeWidth={2.5} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Dictado por voz */}
          <button
            type="button"
            title={dictationStatus === 'recording' ? 'Detener grabación' : dictationStatus === 'transcribing' ? 'Transcribiendo…' : 'Dictar por voz'}
            aria-label={dictationStatus === 'recording' ? 'Detener grabación' : 'Dictar por voz'}
            aria-pressed={dictationStatus === 'recording'}
            onClick={onDictate}
            disabled={dictationStatus === 'transcribing' || disabled}
            className={`flex size-[33px] items-center justify-center rounded-full text-[#44474d] outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-black/5 hover:text-brand-black disabled:opacity-40 disabled:cursor-not-allowed ${
              dictationStatus === 'recording' ? 'animate-pulse bg-red-500 text-white hover:bg-red-600 hover:text-white' : ''
            }`}
          >
            {dictationStatus === 'transcribing' ? (
              <Loader2 className="size-[18px] animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : dictationStatus === 'recording' ? (
              <Square className="size-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
            ) : (
              <Mic className="size-[18px]" strokeWidth={2} aria-hidden="true" />
            )}
          </button>

          {/* Enviar / Detener — el mismo botón cambia de forma durante el streaming */}
          {streaming && onStop ? (
            <button
              type="button"
              title="Detener (Esc)"
              aria-label="Detener ejecución"
              onClick={onStop}
              className="flex size-[34px] items-center justify-center rounded-full bg-brand-black text-white outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-brand-black/85"
            >
              <Square className="size-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              title="Enviar"
              onClick={onSubmit}
              disabled={disabled || !canSend}
              className={`flex size-[34px] items-center justify-center rounded-full bg-brand-orange text-white shadow-[0_2px_8px_rgba(254,112,11,0.35)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-brand-orange-dark ${
                disabled || !canSend ? 'cursor-default opacity-50 hover:bg-brand-orange' : ''
              }`}
            >
              <ArrowUp className="size-[19px]" strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Chip de carpeta activa — visible cuando hay cwd seleccionado */}
      {cwd && (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-slate-400">
          <FolderOpen className="size-3" strokeWidth={2} aria-hidden="true" />
          <span className="truncate font-mono">{cwd}</span>
          <button
            type="button"
            onClick={onClearFolder}
            className="ml-auto shrink-0 rounded p-0.5 text-slate-300 hover:text-slate-500 hover:bg-black/5"
            title="Quitar carpeta"
          >
            <X className="size-3" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
