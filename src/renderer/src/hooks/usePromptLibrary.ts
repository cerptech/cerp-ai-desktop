import { useEffect, useState } from 'react'
import { getFallbackLibrary, pickLibrary, type PromptLibraryResponse } from '@/lib/promptLibrary'

/**
 * usePromptLibrary — biblioteca de prompts preparados del canal desktop (F1c).
 *
 * Arranca con el respaldo empaquetado (se pinta al instante, sin esperar red) y
 * lo reemplaza por el catálogo de cerp-ai-service cuando llega. El main hace el
 * fetch (timeout 3 s, cache por sesión): si falla devuelve null y queda el respaldo.
 */
export function usePromptLibrary(): PromptLibraryResponse {
  const [library, setLibrary] = useState<PromptLibraryResponse>(() => getFallbackLibrary())

  useEffect(() => {
    let cancelled = false
    window.cerpAPI
      .getPromptLibrary()
      .then((remote) => {
        if (!cancelled && remote) setLibrary(pickLibrary(remote))
      })
      .catch(() => {
        /* no-op — se queda con el respaldo local */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return library
}
