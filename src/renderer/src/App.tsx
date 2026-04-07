import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/pages/LoginPage'
import { SetupPage } from '@/pages/SetupPage'
import { ChatPage } from '@/pages/ChatPage'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ToastProvider } from '@/hooks/useToast'
import { ToastContainer } from '@/components/ui/ToastContainer'

export default function App() {
  const { isAuthenticated, user, loading, login, logout } = useAuth()
  const [setupDone, setSetupDone] = useState<boolean>(() => {
    // v1.0.6+: require setup version 2 (includes git check)
    return localStorage.getItem('cerp-setup-version') === '2'
  })

  // Initial loading check
  if (loading && !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  // Python setup (only on first run)
  if (!setupDone) {
    return (
      <SetupPage
        onComplete={() => {
          localStorage.setItem('cerp-setup-version', '2')
          setSetupDone(true)
        }}
      />
    )
  }

  if (!isAuthenticated) {
    return <LoginPage onLogin={login} loading={loading} />
  }

  return (
    <ToastProvider>
      <ChatPage userName={user?.name} onLogout={logout} />
      <ToastContainer />
    </ToastProvider>
  )
}
