import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Rabbit, Sparkles, Brain } from 'lucide-react'
import type { ModelChoice } from '@/hooks/useModelChoice'

interface ModelSelectorProps {
  value: ModelChoice
  onChange: (choice: ModelChoice) => void
  /** Turbo Mode fija Opus + xhigh y tiene prioridad — el selector queda deshabilitado
   *  visualmente para no sugerir que la elección hace algo mientras Turbo está activo. */
  disabled?: boolean
}

const OPTIONS: Array<{ value: ModelChoice; label: string; hint: string; icon: typeof Sparkles }> = [
  { value: 'auto', label: 'Auto', hint: 'El modelo recomendado según tu plan', icon: Sparkles },
  { value: 'fast', label: 'Rápido', hint: 'Respuestas más rápidas, para consultas simples', icon: Rabbit },
  { value: 'powerful', label: 'Potente', hint: 'Máximo razonamiento, para tareas complejas', icon: Brain },
]

/** Selector de modelo (Ola 1) — pill compacto con dropdown, mismo patrón visual que
 *  los toggles de Modo plan / Turbo de ChatContainer. */
export function ModelSelector({ value, onChange, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]
  const CurrentIcon = current.icon

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-pressed={open}
        disabled={disabled}
        className={`h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border text-sm font-medium transition-all ${
          disabled
            ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed opacity-60'
            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
        }`}
        title={disabled ? 'Modo Turbo activo — fija el modelo automáticamente' : `Modelo: ${current.label}`}
      >
        <CurrentIcon className="size-4" strokeWidth={2} aria-hidden="true" />
        <span>{current.label}</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && !disabled && (
        <div className="absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-slate-200 bg-white shadow-lg py-1.5 z-20">
          {OPTIONS.map((option) => {
            const Icon = option.icon
            const isActive = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-50 transition-colors"
              >
                <Icon className="size-4 mt-0.5 shrink-0 text-slate-500" strokeWidth={2} aria-hidden="true" />
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-slate-800">{option.label}</span>
                  <span className="text-xs text-slate-400">{option.hint}</span>
                </span>
                {isActive && <Check className="size-4 ml-auto shrink-0 text-brand-orange" strokeWidth={2.5} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
