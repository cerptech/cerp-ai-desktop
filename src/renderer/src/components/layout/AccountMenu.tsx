import { useEffect, useRef, useState } from 'react'
import { ChevronDown, History, LogOut } from 'lucide-react'

interface AccountMenuProps {
  userName: string
  userEmail?: string
  onShowHistory: () => void
  onLogout?: () => void
}

/**
 * Iniciales para el avatar: nombre + primer apellido. Con 4 palabras se asume
 * nombre compuesto («Emanuel Jesús Pachano Piña» → EP); con 2 o 3, la segunda.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const surname = parts.length >= 4 ? parts[2] : parts[1]
  const letters = (parts[0]?.[0] ?? '') + (surname?.[0] ?? '')
  return (letters || '?').toUpperCase()
}

/**
 * Avatar de la cabecera con su menú: la cuenta, el historial de créditos y
 * cerrar sesión (antes eran tres textos sueltos en la barra).
 */
export function AccountMenu({ userName, userEmail, onShowHistory, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menú de la cuenta"
        title={userName}
        className="inline-flex h-[30px] items-center gap-1 rounded-full border border-composer-border bg-white pl-[3px] pr-1.5 text-[#52525b] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-brand-orange/40"
      >
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary-100 text-[11px] font-bold text-primary-800">
          {initialsOf(userName)}
        </span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 w-60 rounded-[14px] border border-composer-border bg-white p-1.5 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
          <div className="mb-1 border-b border-[#f1f1f1] px-2.5 pb-2 pt-2.5">
            <p className="truncate text-[13px] font-semibold text-brand-black">{userName}</p>
            {userEmail && <p className="truncate text-xs text-slate-500">{userEmail}</p>}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onShowHistory() }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-brand-black transition-colors hover:bg-black/5"
          >
            <History className="size-[15px]" strokeWidth={2} aria-hidden="true" />
            Historial de créditos
          </button>
          {onLogout && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onLogout() }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-red-700 transition-colors hover:bg-red-50"
            >
              <LogOut className="size-[15px]" strokeWidth={2} aria-hidden="true" />
              Cerrar sesión
            </button>
          )}
        </div>
      )}
    </div>
  )
}
