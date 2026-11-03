import { useCallback, useEffect, useState } from 'react'
import type { UpdaterSnapshot } from '../../../preload/index'

export type { UpdaterSnapshot }

/**
 * useUpdater — estado del auto-update, que decide SOLO el main (src/main/updater.ts).
 * Pide la foto al montar y se queda con cada cambio que empuja el main; `seq`
 * descarta una foto más vieja (la respuesta del pedido inicial puede llegar después
 * de un cambio). `null` mientras no llegó la primera.
 *
 * Las acciones no deciden nada: el main ignora un chequeo si ya hay uno, una descarga
 * en curso o una versión lista, y solo instala si hay una descargada.
 */
export function useUpdater(): {
  snapshot: UpdaterSnapshot | null
  check: () => void
  install: () => void
} {
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot | null>(null)

  const accept = useCallback((next: UpdaterSnapshot): void => {
    setSnapshot((prev) => (prev && prev.seq > next.seq ? prev : next))
  }, [])

  useEffect(() => {
    let cancelled = false
    const take = (next: UpdaterSnapshot): void => {
      if (!cancelled) accept(next)
    }
    const unsubscribe = window.cerpAPI.onUpdateState(take)
    window.cerpAPI
      .getUpdateState()
      .then(take)
      .catch(() => {
        /* no-op — los cambios siguen llegando por onUpdateState */
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [accept])

  const check = useCallback((): void => {
    window.cerpAPI
      .checkForUpdates()
      .then(accept)
      .catch(() => {
        /* no-op — el error del chequeo llega como estado `error` */
      })
  }, [accept])

  const install = useCallback((): void => {
    void window.cerpAPI.quitAndInstallUpdate()
  }, [])

  return { snapshot, check, install }
}
