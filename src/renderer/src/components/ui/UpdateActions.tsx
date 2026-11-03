import { useState, type ReactElement } from 'react'
import { CircleCheck, ExternalLink } from 'lucide-react'
import { Button } from './Button'
import { LoadingSpinner } from './LoadingSpinner'
import { DESKTOP_RELEASES_URL } from '@/constants/desktopRelease'
import type { UpdaterSnapshot } from '@/hooks/useUpdater'

interface UpdateActionsProps {
  snapshot: UpdaterSnapshot
  onCheck: () => void
  onInstall: () => void
  /**
   * El core exige una versión más nueva (426): el botón inicial es «Actualizar ahora»,
   * «sin novedades» no se presenta como «Tienes la última versión» y la descarga
   * manual queda a mano en todos los estados menos con la versión ya lista: la
   * pantalla obligatoria del chat nunca se queda sin salida.
   */
  required?: boolean
}

/** «14:32» si fue hoy; «2 nov, 14:32» si no (el equipo pudo estar suspendido). */
function formatCheckedAt(epochMs: number): string {
  const date = new Date(epochMs)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Barra de progreso de la descarga (también la usa el aviso flotante). */
export function UpdateProgressBar({ percent }: { percent: number }): ReactElement {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="h-full rounded-full bg-brand-orange transition-all duration-300" style={{ width: `${percent}%` }} />
    </div>
  )
}

function DownloadLink({ primary = false }: { primary?: boolean }): ReactElement {
  return (
    <a
      href={DESKTOP_RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={
        primary
          ? 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-orange px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-orange/90'
          : 'inline-flex items-center gap-1 text-sm font-medium text-slate-600 underline-offset-2 transition-colors hover:text-brand-black hover:underline'
      }
    >
      Descargar la última versión
      <ExternalLink className="size-3.5" strokeWidth={2} aria-hidden="true" />
    </a>
  )
}

/**
 * Estado y acción del auto-update según la máquina de estados del main. Lo comparten
 * la sección «Actualizaciones» de Configuración y la pantalla de actualización
 * obligatoria del chat, para que las dos digan lo mismo en cada estado.
 */
export function UpdateActions({ snapshot, onCheck, onInstall, required = false }: UpdateActionsProps): ReactElement {
  // «Reiniciando…» vale para la foto en la que se tocó: si el instalador no arranca,
  // el main pasa a `error` (seq nuevo) y el botón no queda trabado.
  const [restartSeq, setRestartSeq] = useState<number | null>(null)
  const restarting = restartSeq === snapshot.seq
  const { state } = snapshot
  const manualDownload = required ? <DownloadLink /> : null

  const handleInstall = (): void => {
    setRestartSeq(snapshot.seq)
    onInstall()
  }

  switch (state.status) {
    case 'unsupported':
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-slate-600">
            {state.reason === 'macos'
              ? 'En macOS la actualización es manual: descarga la última versión e instálala sobre la actual.'
              : 'Esta copia de desarrollo no se actualiza sola: la actualización es manual.'}
          </p>
          <DownloadLink primary />
        </div>
      )

    case 'idle':
      return (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onCheck}>
            {required ? 'Actualizar ahora' : 'Buscar actualizaciones'}
          </Button>
          {manualDownload}
        </div>
      )

    case 'checking':
      return (
        <div className="flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <LoadingSpinner size="sm" />
            <span>Buscando…</span>
          </div>
          {manualDownload}
        </div>
      )

    case 'not-available':
      return required ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-amber-700">Todavía no hay una versión más nueva para descargar. Vuelve a intentarlo en unos minutos.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={onCheck}>
              Reintentar
            </Button>
            {manualDownload}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
              <CircleCheck className="size-4" strokeWidth={2} aria-hidden="true" />
              Tienes la última versión
            </p>
            <p className="mt-0.5 text-xs text-slate-500">Última comprobación: {formatCheckedAt(state.checkedAt)}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={onCheck}>
            Buscar actualizaciones
          </Button>
        </div>
      )

    case 'available':
    case 'downloading': {
      const percent = state.status === 'downloading' ? state.percent : 0
      return (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm text-slate-700">
            Descargando {percent} %{state.version ? <span className="text-slate-500"> · versión {state.version}</span> : null}
          </p>
          <UpdateProgressBar percent={percent} />
          {/* Sin botón propio: si la descarga se traba, el watchdog del main la pasa a `error` con «Reintentar». */}
          {manualDownload && <div className="mt-1">{manualDownload}</div>}
        </div>
      )
    }

    case 'downloaded':
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm font-medium text-slate-800">Versión {state.version} lista</p>
          <Button size="sm" onClick={handleInstall} disabled={restarting}>
            {restarting ? 'Reiniciando…' : 'Reiniciar e instalar'}
          </Button>
        </div>
      )

    case 'error':
      return (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-red-700">{state.message}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant={required ? 'primary' : 'secondary'} onClick={onCheck}>
              Reintentar
            </Button>
            {/* Si la actualización automática no llega, queda la descarga manual. */}
            {manualDownload}
          </div>
        </div>
      )
  }
}
