import { useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { LoadingSpinner } from './LoadingSpinner'

interface SessionExpiredModalProps {
  /** Dispara el flujo de login existente (Auth0, navegador del sistema). */
  onLogin: () => Promise<void>
  onClose: () => void
}

/**
 * Se muestra cuando el refresh token no existe o el backend lo rechazó (Auth0
 * revocado/expirado) y no se pudo renovar la sesión sola — ver
 * `auth:session-expired` en el main process (handlers.ts → onTokenExpired).
 */
export function SessionExpiredModal({ onLogin, onClose }: SessionExpiredModalProps) {
  const [loading, setLoading] = useState(false)

  const handleLogin = async (): Promise<void> => {
    setLoading(true)
    try {
      await onLogin()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Tu sesión expiró" onClose={onClose} width="max-w-sm">
      <p className="text-sm text-slate-600">
        Inicia sesión de nuevo para continuar.
      </p>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          Cerrar
        </Button>
        <Button variant="primary" onClick={handleLogin} disabled={loading}>
          {loading ? (
            <span className="flex items-center gap-2">
              <LoadingSpinner size="sm" />
              Conectando...
            </span>
          ) : (
            'Iniciar sesión'
          )}
        </Button>
      </div>
    </Modal>
  )
}
