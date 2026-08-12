import { useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'

/**
 * React exige que el array de dependencias de un `useEffect` tenga SIEMPRE la
 * misma longitud entre renders — si cambia, tira "The final argument passed to
 * useEffect changed size between renders". `deps` acá es una `DependencyList`
 * arbitraria que controla el CALLER; hoy el único caller (ChatContainer) siempre
 * pasa un array literal de 3 elementos, así que no explota, pero es un bug latente
 * en la firma del componente: cualquier caller futuro que pase un array de
 * longitud variable (o el mismo caller cambiando esa lista) rompe en runtime.
 *
 * Esta hook convierte `deps` (longitud variable) en un número de versión estable
 * (longitud fija: siempre un solo valor) comparando por referencia cada elemento
 * durante el render — sin usar un Effect, así que no dispara un render extra por
 * sí sola. El array real de `useEffect` más abajo queda con longitud fija
 * (`[depsVersion, stickToBottom, busy]`) sin importar cuántos elementos traiga `deps`.
 */
function useDepsVersion(deps: DependencyList): number {
  const prevRef = useRef<DependencyList>([])
  const versionRef = useRef(0)
  const prev = prevRef.current
  const changed = prev.length !== deps.length || deps.some((d, i) => !Object.is(d, prev[i]))
  if (changed) {
    prevRef.current = deps
    versionRef.current += 1
  }
  return versionRef.current
}

/**
 * Margen desde el fondo dentro del cual se considera que el usuario "sigue"
 * la respuesta. Por encima de eso se asume que subió a leer algo y el
 * autoscroll se desengancha hasta que vuelva al final. Port fiel de
 * cerp-ai-frontend/src/components/chat/MessageList.tsx:15-71,107-120 (Ola 2).
 */
const STICK_THRESHOLD_PX = 80

interface MessageListProps {
  children: ReactNode
  /** Disparadores del auto-scroll (mensajes, tools, typing, etc.) — cualquier
   *  cambio reevalúa si hay que bajar (solo si el usuario sigue enganchado). */
  deps: DependencyList
  /** Mientras el turno está en curso el scroll baja SIN animación — encadenar
   *  "smooth" en cada delta de streaming los pisa entre sí y tiembla. */
  busy?: boolean
  className?: string
}

export function MessageList({ children, deps, busy = false, className }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // `false` = el usuario subió a leer: no lo arrastramos de vuelta.
  const [stickToBottom, setStickToBottom] = useState(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickToBottom(distance <= STICK_THRESHOLD_PX)
  }, [])

  const scrollToBottom = useCallback((smooth: boolean) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' })
  }, [])

  const depsVersion = useDepsVersion(deps)

  useEffect(() => {
    if (!stickToBottom) return
    scrollToBottom(!busy)
  }, [depsVersion, stickToBottom, busy, scrollToBottom])

  return (
    <div className={`relative min-h-0 flex-1 ${className ?? ''}`}>
      <div ref={scrollRef} onScroll={handleScroll} className="cerp-scroll h-full overflow-y-auto">
        {children}
        <div ref={bottomRef} />
      </div>

      {!stickToBottom && (
        <button
          type="button"
          onClick={() => {
            setStickToBottom(true)
            scrollToBottom(true)
          }}
          aria-label="Bajar al final de la conversación"
          title="Bajar al final"
          className="absolute bottom-4 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-composer-border bg-white text-brand-black shadow-[0_4px_14px_rgba(16,24,40,0.12)] outline-none transition-colors hover:bg-[#f4f5f7] focus-visible:ring-2 focus-visible:ring-brand-orange/40"
        >
          <ArrowDown className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
