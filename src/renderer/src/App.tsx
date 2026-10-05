import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/pages/LoginPage'
import { ChatPage } from '@/pages/ChatPage'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ToastProvider } from '@/hooks/useToast'
import { ToastContainer } from '@/components/ui/ToastContainer'
import { UpdateBanner } from '@/components/ui/UpdateBanner'
import { SessionExpiredModal } from '@/components/ui/SessionExpiredModal'
import { NoticeModal } from '@/components/ui/NoticeModal'

export default function App() {
  const { isAuthenticated, user, loading, login, logout, markSignedOut } = useAuth()

  // Ola 3: el chequeo/instalación de Git+Python (SetupPage) YA NO bloquea acá antes
  // del login — corre en background una vez autenticado (useToolsSetup, disparado
  // desde ChatContainer) y solo gatea las funciones puntuales que lo necesitan
  // (hoy: "Crear cotización de obra"). El resto del chat funciona igual mientras
  // se prepara, o si falla.

  // El main avisa por acá cuando la sesión murió y no se pudo renovar sola
  // (refresh token ausente/inválido) — ver auth:session-expired en handlers.ts.
  const [sessionExpired, setSessionExpired] = useState(false)
  // Se incrementa tras un re-login exitoso para remontar ChatPage: así los
  // hooks que solo cargan datos al montar (conversaciones, créditos, etc.)
  // vuelven a pedirlos con la sesión fresca, sin reiniciar la app.
  const [sessionKey, setSessionKey] = useState(0)

  useEffect(() => window.cerpAPI.onSessionExpired(() => setSessionExpired(true)), [])

  // Multi-empresa (plan DK-1.1). 409 COMPANY_CHANGED: el main ya volvió a pedir la
  // config y detuvo los turnos en curso; acá se avisa y, al cerrar el aviso, se
  // remonta ChatPage para que conversaciones/créditos se vuelvan a pedir con la
  // empresa nueva. 403 NO_ACTIVE_COMPANY: el main ya cerró la sesión; se vuelve al
  // login con el mensaje encima.
  const [companyNotice, setCompanyNotice] = useState<string | null>(null)
  const [noCompanyMessage, setNoCompanyMessage] = useState<string | null>(null)

  useEffect(() => window.cerpAPI.onCompanyChanged((notice) => setCompanyNotice(notice.message)), [])
  useEffect(
    () =>
      window.cerpAPI.onNoActiveCompany(({ message }) => {
        setSessionExpired(false)
        setCompanyNotice(null)
        setNoCompanyMessage(message)
        markSignedOut()
      }),
    [markSignedOut],
  )

  const handleCompanyNoticeClose = useCallback((): void => {
    setCompanyNotice(null)
    setSessionKey((k) => k + 1)
  }, [])

  const handleSessionReLogin = useCallback(async (): Promise<void> => {
    await login()
    setSessionExpired(false)
    setSessionKey((k) => k + 1)
  }, [login])

  let content: React.ReactNode

  if (loading && !isAuthenticated) {
    // Initial loading check
    content = (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <LoadingSpinner size="lg" />
      </div>
    )
  } else if (!isAuthenticated) {
    content = <LoginPage onLogin={login} loading={loading} />
  } else {
    content = (
      <ToastProvider>
        <ChatPage key={sessionKey} userName={user?.name} onLogout={logout} />
        <ToastContainer />
        <UpdateBanner />
      </ToastProvider>
    )
  }

  return (
    <>
      {content}
      {sessionExpired && (
        <SessionExpiredModal onLogin={handleSessionReLogin} onClose={() => setSessionExpired(false)} />
      )}
      {companyNotice && !sessionExpired && (
        <NoticeModal title="Cambió tu empresa por defecto" message={companyNotice} onClose={handleCompanyNoticeClose} />
      )}
      {noCompanyMessage && (
        <NoticeModal title="Sin acceso a ninguna empresa" message={noCompanyMessage} onClose={() => setNoCompanyMessage(null)} />
      )}
    </>
  )
}
