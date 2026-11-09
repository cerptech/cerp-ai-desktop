import { useState, useEffect, useCallback } from 'react'

/**
 * usePlanMode — sync the Plan Mode toggle with the main process.
 *
 * Plan Mode NO usa `permissionMode: 'plan'` del SDK (inyecta ExitPlanMode). El main
 * process añade una directiva al prompt y bloquea las tools de escritura del servidor
 * `cerp` (planModeGuard.ts): devuelven error en vez de ejecutarse. Al cambiar el modo
 * se cierra la sesión y el próximo mensaje arranca con el modo nuevo.
 */
export function usePlanMode() {
  const [planMode, setPlanModeState] = useState(false)

  // Hydrate from main process on mount
  useEffect(() => {
    window.cerpAPI.getPlanMode().then(setPlanModeState).catch(() => {/* no-op */})
  }, [])

  const togglePlanMode = useCallback(async () => {
    const next = !planMode
    setPlanModeState(next)
    await window.cerpAPI.setPlanMode(next)
  }, [planMode])

  return { planMode, togglePlanMode }
}
