import { useEffect, useState } from 'react'
import type { AiModelPolicy } from '../../../preload/index'

export type { AiModelPolicy }

/** Releer cada tanto: la política de la empresa puede cambiar sin reiniciar la app. */
const REFRESH_MS = 5 * 60 * 1000

/**
 * useModelPolicy — política de modelo de la empresa (ADR 016 del core) para el
 * selector del composer. `null` mientras no se conoce (sin sesión, backend
 * anterior o config todavía no cacheada): en ese caso la UI no bloquea nada,
 * y el main igual recorta "Potente" al enviar si corresponde.
 *
 * Se refresca al volver el foco a la ventana y cada 5 min: la política puede
 * cambiar del lado del core sin que el usuario haga nada, y el selector tiene
 * que reflejar qué opciones hay sin reiniciar la app. La UI no explica el
 * motivo de un cambio (política comercial interna).
 */
export function useModelPolicy(): AiModelPolicy | null {
  const [policy, setPolicy] = useState<AiModelPolicy | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      window.cerpAPI
        .getModelPolicy()
        .then((p) => {
          if (!cancelled) setPolicy(p)
        })
        .catch(() => {
          /* no-op — se queda con el último valor conocido */
        })
    }
    load()
    const interval = window.setInterval(load, REFRESH_MS)
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', load)
    }
  }, [])

  return policy
}
