import { useEffect, useState, type ReactElement } from 'react'

/**
 * Aviso de auto-actualización.
 *
 * Flujo (decisión de producto 2026-06-18): el main process descarga la nueva
 * versión en segundo plano apenas la detecta. Mientras descarga mostramos un
 * aviso discreto con el progreso; cuando termina, lo cambiamos por el botón
 * "Reiniciar para actualizar". Si el usuario lo ignora, la actualización se
 * aplica sola la próxima vez que cierre la app (autoInstallOnAppQuit).
 */
export function UpdateBanner(): ReactElement | null {
  const [version, setVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const unsubAvailable = window.cerpAPI.onUpdateAvailable(({ version }) => {
      setVersion(version)
      setPercent(0)
      setReady(false)
      setDismissed(false)
    })
    const unsubProgress = window.cerpAPI.onUpdateDownloadProgress(({ percent }) => {
      setPercent(percent)
    })
    const unsubDownloaded = window.cerpAPI.onUpdateDownloaded(({ version }) => {
      setVersion(version)
      setReady(true)
      setPercent(100)
    })
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
    }
  }, [])

  // Nada para mostrar, o el usuario cerró el aviso de "descargando".
  if (!version) return null
  if (!ready && dismissed) return null

  const handleRestart = async (): Promise<void> => {
    setRestarting(true)
    await window.cerpAPI.quitAndInstallUpdate()
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
                La versión {version} se instalará al reiniciar CERP IA.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleRestart}
                  disabled={restarting}
                  className="inline-flex items-center justify-center rounded-lg bg-brand-orange px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-orange/90 disabled:opacity-50"
                >
                  {restarting ? 'Reiniciando…' : 'Reiniciar para actualizar'}
                </button>
                <button
                  onClick={() => setDismissed(true)}
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
                Nueva versión {version} — se instalará sin interrumpir tu trabajo.
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-orange transition-all duration-300"
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            </>
          )}
        </div>

        {!ready && (
          <button
            onClick={() => setDismissed(true)}
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
