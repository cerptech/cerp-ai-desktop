import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/pages/LoginPage'
import { SetupPage } from '@/pages/SetupPage'
import { ChatPage } from '@/pages/ChatPage'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ToastProvider } from '@/hooks/useToast'
import { ToastContainer } from '@/components/ui/ToastContainer'
import { UpdateBanner } from '@/components/ui/UpdateBanner'
import { SessionExpiredModal } from '@/components/ui/SessionExpiredModal'

export default function App() {
  const { isAuthenticated, user, loading, login, logout } = useAuth()
  const [setupDone, setSetupDone] = useState<boolean>(() => {
    // v1.0.6+: require setup version 2 (includes git check)
    return localStorage.getItem('cerp-setup-version') === '2'
  })

  // El main avisa por acá cuando la sesión murió y no se pudo renovar sola
  // (refresh token ausente/inválido) — ver auth:session-expired en handlers.ts.
  const [sessionExpired, setSessionExpired] = useState(false)
  // Se incrementa tras un re-login exitoso para remontar ChatPage: así los
  // hooks que solo cargan datos al montar (conversaciones, créditos, etc.)
  // vuelven a pedirlos con la sesión fresca, sin reiniciar la app.
  const [sessionKey, setSessionKey] = useState(0)

  useEffect(() => window.cerpAPI.onSessionExpired(() => setSessionExpired(true)), [])

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
  } else if (!setupDone) {
    // Python setup (only on first run)
    content = (
      <SetupPage
        onComplete={() => {
          localStorage.setItem('cerp-setup-version', '2')
          setSetupDone(true)
        }}
      />
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
    </>
  )
}
