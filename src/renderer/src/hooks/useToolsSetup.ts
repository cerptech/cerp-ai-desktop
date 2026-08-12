import { useEffect, useSyncExternalStore } from 'react'
import {
  subscribeToolsSetup,
  getToolsSetupSnapshot,
  ensureToolsSetupStarted,
  retryToolsSetup,
} from '../stores/toolsSetupStore'

/**
 * Vista React del estado de preparación de Git/Python (Ola 3). Arranca el chequeo
 * en background la primera vez que se monta cualquier componente que use este hook
 * (idempotente — no importa cuántos componentes lo usen a la vez).
 */
export function useToolsSetup() {
  useEffect(() => {
    ensureToolsSetupStarted()
  }, [])

  const state = useSyncExternalStore(subscribeToolsSetup, getToolsSetupSnapshot)

  return {
    ...state,
    ready: state.status === 'ready',
    preparing: state.status === 'checking' || state.status === 'installing',
    retry: retryToolsSetup,
  }
}
