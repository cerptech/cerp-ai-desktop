import { useState, useEffect, useCallback } from 'react'

/**
 * usePlanMode — sync the Plan Mode toggle with the main process.
 *
 * Plan Mode maps to `permissionMode: 'plan'` in the Claude Agent SDK.
 * When active, the agent can use read-only tools and will propose a plan
 * before taking any write action. The main process closes the current
 * session when the mode changes, so the next message starts fresh with
 * the correct permissionMode.
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
