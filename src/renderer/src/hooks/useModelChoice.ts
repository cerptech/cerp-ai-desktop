import { useCallback, useEffect, useState } from 'react'
import type { ModelChoice } from '../../../preload/index'

export type { ModelChoice }

const STORAGE_PREFIX = 'cerp-ai-desktop:model-choice'

function isModelChoice(value: string | null): value is ModelChoice {
  return value === 'auto' || value === 'fast' || value === 'powerful'
}

/**
 * useModelChoice — selector de modelo del composer (Ola 1).
 *
 * 'auto' usa el modelo que informa el backend en /desktop/api-key (config por plan
 * de la empresa, resuelto en el main — ver `resolveModel` en handlers.ts). 'fast' y
 * 'powerful' fuerzan Haiku/Opus respectivamente. 'powerful' ("Potente") absorbe lo
 * que antes era el Modo Turbo (pill separada, eliminada): además de Opus, agentManager
 * le aplica effort 'xhigh', habilita la tool Workflow y sube el techo de presupuesto.
 *
 * Se persiste en localStorage por usuario (email) — no hay un solo perfil de SO por
 * instalación garantizado, así que sin el email todos los usuarios de una misma
 * máquina compartirían la preferencia.
 */
export function useModelChoice() {
  const [modelChoice, setModelChoiceState] = useState<ModelChoice>('auto')
  const [storageKey, setStorageKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.cerpAPI.getAuthStatus().then((state) => {
      if (cancelled) return
      const key = `${STORAGE_PREFIX}:${state.user?.email || 'anon'}`
      setStorageKey(key)
      try {
        const saved = localStorage.getItem(key)
        if (isModelChoice(saved)) setModelChoiceState(saved)
      } catch {
        /* localStorage no disponible (modo privado, etc.) — se queda en 'auto' */
      }
    }).catch(() => { /* no-op — se queda en 'auto' */ })
    return () => { cancelled = true }
  }, [])

  const setModelChoice = useCallback((choice: ModelChoice) => {
    setModelChoiceState(choice)
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, choice)
      } catch {
        /* no-op */
      }
    }
  }, [storageKey])

  return { modelChoice, setModelChoice }
}
