import { useCallback, useSyncExternalStore } from 'react'

/** true mientras la media query coincide (se actualiza al redimensionar la ventana). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', cb)
    return () => mql.removeEventListener('change', cb)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}
