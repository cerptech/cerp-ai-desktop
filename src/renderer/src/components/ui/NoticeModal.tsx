import { Modal } from './Modal'
import { Button } from './Button'

interface NoticeModalProps {
  title: string
  message: string
  onClose: () => void
}

/**
 * Aviso de un solo botón. Lo usan los errores de empresa del core (multi-empresa,
 * plan DK-1.1): «Tu empresa por defecto cambió a …» (409 COMPANY_CHANGED) y «Tu
 * cuenta ya no tiene acceso a ninguna empresa» (403 NO_ACTIVE_COMPANY). El texto
 * lo arma el main (`src/main/utils/sessionErrors.ts`).
 */
export function NoticeModal({ title, message, onClose }: NoticeModalProps) {
  return (
    <Modal title={title} onClose={onClose} width="max-w-sm">
      <p className="text-sm text-slate-600">{message}</p>

      <div className="mt-6 flex items-center justify-end">
        <Button variant="primary" onClick={onClose}>
          Entendido
        </Button>
      </div>
    </Modal>
  )
}
