import { useEffect, useState } from 'react'
import type { AiModelPolicy } from '../../../preload/index'

export type { AiModelPolicy }

/** Releer cada tanto: la política cambia sola al cruzar el umbral o al reset del período. */
const REFRESH_MS = 5 * 60 * 1000

/**
 * useModelPolicy — política de modelo de la empresa (ADR 016 del core) para el
 * selector del composer. `null` mientras no se conoce (sin sesión, backend
 * anterior o config todavía no cacheada): en ese caso la UI no bloquea nada,
 * y el main igual recorta "Potente" al enviar si corresponde.
 *
 * Se refresca al volver el foco a la ventana y cada 5 min — la degradación
 * por consumo entra sin que el usuario haga nada, y queremos que el hint del
 * selector lo cuente sin reiniciar la app.
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
