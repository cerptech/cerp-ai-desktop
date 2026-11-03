import { Download } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { UpdateActions } from '@/components/ui/UpdateActions'
import type { UpdaterSnapshot } from '@/hooks/useUpdater'

/** Aviso de versión mínima (código `DESKTOP_UPDATE_REQUIRED`), el mismo texto que arma el main. */
const DESKTOP_UPDATE_REQUIRED_TEXT = 'Actualiza CERP IA Desktop a la última versión para seguir usándolo.'

interface UpdateRequiredScreenProps {
  /** null mientras llega la primera foto del updater. */
  snapshot: UpdaterSnapshot | null
  onCheck: () => void
  onInstall: () => void
}

/**
 * Pantalla de actualización obligatoria (426 `DESKTOP_UPDATE_REQUIRED`, F0.2 (b)):
 * tapa el chat, que no puede enviar hasta actualizar. El texto sale del código, no
 * del servidor. El main ya lanzó la búsqueda con el primer 426; desde acá solo la
 * relanza el usuario («Actualizar ahora», «Reintentar»), así que no hay bucle.
 */
export function UpdateRequiredScreen({ snapshot, onCheck, onInstall }: UpdateRequiredScreenProps) {
  return (
    <div
      role="region"
      aria-labelledby="update-required-title"
      aria-describedby="update-required-text"
      className="absolute inset-0 z-20 flex items-center justify-center bg-white/95 px-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-composer-border bg-white p-6 shadow-[0_12px_32px_rgba(16,24,40,0.14)]">
        <div className="flex size-10 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <Download className="size-5" strokeWidth={2} aria-hidden="true" />
        </div>
        <h2 id="update-required-title" className="mt-4 text-base font-semibold text-brand-black">
          Hace falta actualizar
        </h2>
        <p id="update-required-text" className="mt-1 text-sm text-slate-600">
          {DESKTOP_UPDATE_REQUIRED_TEXT}
        </p>
        {snapshot && <p className="mt-1 text-xs text-slate-500">Versión instalada {snapshot.currentVersion}</p>}
        <div className="mt-5">
          {snapshot ? <UpdateActions snapshot={snapshot} onCheck={onCheck} onInstall={onInstall} required /> : <LoadingSpinner size="sm" />}
        </div>
      </div>
    </div>
  )
}
