import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import cerpLogo from '@/assets/images/cerp-logo.png'

interface LoginPageProps {
  onLogin: () => void
  loading: boolean
}

export function LoginPage({ onLogin, loading }: LoginPageProps) {
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.cerpAPI.getVersion().then(setAppVersion).catch(() => setAppVersion(''))
  }, [])

  return (
    <div className="relative flex flex-col items-center justify-center h-screen bg-gradient-to-b from-slate-50 via-white to-white">
      <div className="text-center max-w-sm px-6">
        <img src={cerpLogo} alt="CERP" className="w-16 h-16 object-contain mx-auto mb-6" />

        <h1 className="text-2xl font-semibold text-brand-black mb-2">CERP AI Desktop</h1>
        <p className="text-slate-500 text-[15px] leading-relaxed mb-8">
          Analiza pliegos y presupuestos sin que salgan de tu equipo.
        </p>

        <button
          type="button"
          onClick={onLogin}
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand-orange px-6 py-3 text-[15px] font-medium text-white shadow-[0_2px_8px_rgba(254,112,11,0.35)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-brand-orange-dark disabled:cursor-default disabled:opacity-60"
        >
          {loading ? (
            <>
              <LoadingSpinner size="sm" />
              Conectando…
            </>
          ) : (
            <>
              Iniciar sesión
              <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
            </>
          )}
        </button>

        <p className="text-xs text-slate-400 mt-4">
          Usa las mismas credenciales que en la app web de CERP
        </p>
      </div>

      {appVersion && (
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-300">CERP AI Desktop v{appVersion}</p>
      )}
    </div>
  )
}
