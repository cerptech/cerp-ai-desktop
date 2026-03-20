import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

interface LoginPageProps {
  onLogin: () => void
  loading: boolean
}

export function LoginPage({ onLogin, loading }: LoginPageProps) {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-slate-50">
      <div className="text-center max-w-sm">
        {/* Logo */}
        <div className="w-20 h-20 rounded-2xl bg-brand-orange flex items-center justify-center mx-auto mb-6">
          <span className="text-white font-bold text-3xl">C</span>
        </div>

        <h1 className="text-2xl font-bold text-slate-800 mb-2">CERP AI</h1>
        <p className="text-slate-500 text-sm mb-8">
          Tu asistente inteligente para la gestion de obras y proyectos de construccion
        </p>

        <Button size="lg" onClick={onLogin} disabled={loading} className="w-full">
          {loading ? (
            <span className="flex items-center gap-2">
              <LoadingSpinner size="sm" />
              Conectando...
            </span>
          ) : (
            'Iniciar sesion'
          )}
        </Button>

        <p className="text-xs text-slate-400 mt-4">
          Usa las mismas credenciales que en la app web de CERP
        </p>
      </div>
    </div>
  )
}
