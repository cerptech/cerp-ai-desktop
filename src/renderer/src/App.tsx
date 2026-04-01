import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/pages/LoginPage'
import { ChatPage } from '@/pages/ChatPage'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ToastProvider } from '@/hooks/useToast'
import { ToastContainer } from '@/components/ui/ToastContainer'

export default function App() {
  const { isAuthenticated, user, loading, login, logout } = useAuth()

  // Initial loading check
  if (loading && !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <LoadingSpinner size="lg" />
      </div>
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
