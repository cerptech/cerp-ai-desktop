import { useState, useEffect, useCallback } from 'react'

/**
 * useTurboMode — sincroniza el toggle de Modo Turbo (Idea 3) con el main process.
 *
 * Turbo sube el rigor de la ejecución para cotizaciones complejas (modelo Opus
 * xhigh-capable + effort 'xhigh' + orquestación de workflows). El main cierra la
 * sesión activa al cambiar el modo, así el próximo mensaje arranca con el modelo
 * y effort correctos. Es opt-in: por defecto está apagado.
 */
export function useTurboMode() {
  const [turboMode, setTurboModeState] = useState(false)

  useEffect(() => {
    window.cerpAPI.getTurboMode().then(setTurboModeState).catch(() => {
      /* no-op */
    })
  }, [])

  const toggleTurboMode = useCallback(async () => {
    const next = !turboMode
    setTurboModeState(next)
    await window.cerpAPI.setTurboMode(next)
  }, [turboMode])

  return { turboMode, toggleTurboMode }
}
