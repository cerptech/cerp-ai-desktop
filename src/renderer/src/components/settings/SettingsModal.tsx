import { Modal } from '@/components/ui/Modal'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { UpdateActions } from '@/components/ui/UpdateActions'
import { useUpdater } from '@/hooks/useUpdater'

interface SettingsModalProps {
  onClose: () => void
}

/**
 * Configuración del Desktop, abierta desde el menú de la cuenta (avatar de la
 * cabecera). Por ahora una sola sección: Actualizaciones.
 */
export function SettingsModal({ onClose }: SettingsModalProps) {
  return (
    <Modal title="Configuración" onClose={onClose} width="max-w-md">
      <UpdatesSection />
    </Modal>
  )
}

/**
 * Versión instalada y auto-update: buscar a pedido, ver la descarga, reiniciar para
 * instalar o, donde la app no se actualiza sola, el enlace a la descarga.
 */
function UpdatesSection() {
  const { snapshot, check, install } = useUpdater()

  return (
    <section aria-labelledby="settings-updates-title" className="flex flex-col gap-3 pb-2">
      <h3 id="settings-updates-title" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        Actualizaciones
      </h3>
      <p className="text-sm text-slate-600">
        Versión instalada <span className="font-semibold text-brand-black">{snapshot?.currentVersion ?? '…'}</span>
      </p>
      {snapshot ? (
        <>
          <UpdateActions snapshot={snapshot} onCheck={check} onInstall={install} required={snapshot.required} />
          {/* El intervalo es PERIODIC_CHECK_INTERVAL_MS de src/main/updater.ts. */}
          {snapshot.state.status !== 'unsupported' && (
            <p className="text-xs text-slate-400">
              La aplicación busca actualizaciones al abrirse y cada 4 horas, y las descarga en segundo plano.
            </p>
          )}
        </>
      ) : (
        <LoadingSpinner size="sm" />
      )}
    </section>
  )
}
