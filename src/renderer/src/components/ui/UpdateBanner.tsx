import { useState, type ReactElement } from 'react'
import { useUpdater } from '@/hooks/useUpdater'
import { UpdateProgressBar } from './UpdateActions'

/**
 * Aviso de auto-actualización.
 *
 * Flujo (decisión de producto 2026-06-18): el main process descarga la nueva
 * versión en segundo plano apenas la detecta. Mientras descarga mostramos un
 * aviso discreto con el progreso; cuando termina, lo cambiamos por el botón
 * "Reiniciar para actualizar". Si el usuario lo ignora, la actualización se
 * aplica sola la próxima vez que cierre la app (autoInstallOnAppQuit).
 *
 * Lee el estado único del main (useUpdater). Solo aparece mientras baja o cuando ya
 * está lista: un chequeo automático sin novedades o fallido no interrumpe (eso se ve
 * en Configuración > Actualizaciones). Con la actualización obligatoria (426) no se
 * muestra: la pantalla del chat ya lleva el progreso y el botón de reinicio.
 */
export function UpdateBanner(): ReactElement | null {
  const { snapshot, install } = useUpdater()
  // Cerrar el aviso vale para ESE paso de ESA versión: el de "descargando" vuelve
  // como "lista" al terminar, y una versión nueva vuelve a avisar.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  // Como en UpdateActions: «Reiniciando…» solo para la foto en la que se tocó.
  const [restartSeq, setRestartSeq] = useState<number | null>(null)

  const state = snapshot?.state
  if (!snapshot || !state || snapshot.required) return null
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'downloaded') return null

  const ready = state.status === 'downloaded'
  const key = `${ready ? 'ready' : 'downloading'}:${state.version}`
  if (dismissedKey === key) return null
  const percent = state.status === 'downloading' ? state.percent : ready ? 100 : 0
  const restarting = restartSeq === snapshot.seq

  const handleRestart = (): void => {
    setRestartSeq(snapshot.seq)
    install()
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/10">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-orange/10">
          <svg className="h-4 w-4 text-brand-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          {ready ? (
            <>
              <p className="text-sm font-medium text-slate-800">Actualización lista</p>
              <p className="mt-0.5 text-xs text-slate-500">
                La versión {state.version} se instalará al reiniciar CERP IA.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleRestart}
                  disabled={restarting}
                  className="inline-flex items-center justify-center rounded-lg bg-brand-orange px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-orange/90 disabled:opacity-50"
                >
                  {restarting ? 'Reiniciando…' : 'Reiniciar para actualizar'}
                </button>
                {/* Oculta el aviso de esta versión (antes no hacía nada: "lista" ignoraba
                    el cierre). Se instala igual al cerrar la app, o desde Configuración. */}
                <button
                  onClick={() => setDismissedKey(key)}
                  disabled={restarting}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100"
                >
                  Más tarde
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-800">Descargando actualización</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Nueva versión {state.version} — se instalará sin interrumpir tu trabajo.
              </p>
              <div className="mt-2">
                <UpdateProgressBar percent={percent} />
              </div>
            </>
          )}
        </div>

        {!ready && (
          <button
            onClick={() => setDismissedKey(key)}
            className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Cerrar"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
