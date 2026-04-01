import { useEffect, useRef } from 'react'

interface AddCustomMenuProps {
  onClose: () => void
  onAddAgent: () => void
  onAddContext: () => void
}

export function AddCustomMenu({ onClose, onAddAgent, onAddContext }: AddCustomMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/10">
      <div ref={ref} className="bg-white rounded-xl shadow-lg border border-slate-200 p-2 w-56">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-3 py-1.5">
          Agregar personalizado
        </p>
        <button
          onClick={onAddAgent}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition-colors text-left"
        >
          <span className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center text-base">
            {'\u{1F916}'}
          </span>
          <div>
            <p className="text-xs font-medium text-slate-700">Agente</p>
            <p className="text-[10px] text-slate-400">Subagente completo con prompt y tools</p>
          </div>
        </button>
        <button
          onClick={onAddContext}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition-colors text-left"
        >
          <span className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center text-base">
            {'\u{1F4DD}'}
          </span>
          <div>
            <p className="text-xs font-medium text-slate-700">Contexto</p>
            <p className="text-[10px] text-slate-400">Instrucciones extra para el orquestador</p>
          </div>
        </button>
      </div>
    </div>
  )
}
