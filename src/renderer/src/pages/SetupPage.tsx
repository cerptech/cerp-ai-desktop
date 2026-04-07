import { useState, useEffect, useCallback } from 'react'
import cerpLogo from '@/assets/images/cerp-logo.png'

interface SetupPageProps {
  onComplete: () => void
}

export function SetupPage({ onComplete }: SetupPageProps) {
  const [status, setStatus] = useState<'checking' | 'installing' | 'done' | 'error'>('checking')
  const [message, setMessage] = useState('Verificando entorno...')
  const [percent, setPercent] = useState(0)
  const [currentStep, setCurrentStep] = useState<'git' | 'python' | 'done'>('git')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)

  const runSetup = useCallback(async () => {
    setStatus('checking')
    setErrorDetail(null)

    // Step 1: Check Git
    setCurrentStep('git')
    setMessage('Verificando Git...')
    setPercent(5)

    const gitStatus = await window.cerpAPI.checkGit()

    if (!gitStatus.installed) {
      setStatus('installing')
      setMessage('Instalando Git (necesario para el funcionamiento de la IA)...')
      setPercent(10)

      const unsubGit = window.cerpAPI.onGitProgress((data) => {
        setMessage(data.message)
        setPercent(data.percent * 0.45) // Git uses 0-45% of the bar
      })

      const gitSuccess = await window.cerpAPI.installGit()
      unsubGit()

      if (!gitSuccess) {
        setStatus('error')
        setErrorDetail(
          'No se pudo instalar Git automaticamente. Por favor instala Git desde git-scm.com y reinicia la app.',
        )
        return
      }
    }

    // Step 2: Check Python
    setCurrentStep('python')
    setMessage('Verificando Python...')
    setPercent(50)

    const pythonStatus = await window.cerpAPI.checkPython()

    if (!pythonStatus.installed || !pythonStatus.pipInstalled) {
      setStatus('installing')
      setMessage('Instalando Python (necesario para generar documentos)...')
      setPercent(55)

      const unsubPython = window.cerpAPI.onPythonProgress((data) => {
        setMessage(data.message)
        setPercent(50 + data.percent * 0.45) // Python uses 50-95% of the bar
      })

      const pythonSuccess = await window.cerpAPI.installPython()
      unsubPython()

      if (!pythonSuccess) {
        setStatus('error')
        setErrorDetail(
          'No se pudo instalar Python automaticamente. Por favor instala Python 3.12+ desde python.org y reinicia la app.',
        )
        return
      }
    }

    // All done
    setCurrentStep('done')
    setStatus('done')
    setMessage('Entorno listo')
    setPercent(100)
    setTimeout(onComplete, 800)
  }, [onComplete])

  useEffect(() => {
    runSetup()
  }, [runSetup])

  return (
    <div className="flex items-center justify-center h-screen bg-slate-50">
      <div className="max-w-md w-full mx-4 text-center">
        {/* Logo */}
        <div className="mb-8">
          <img src={cerpLogo} alt="CERP" className="w-16 h-16 object-contain mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-slate-800">CERP AI</h1>
          <p className="text-sm text-slate-500 mt-1">Preparando tu entorno de trabajo</p>
        </div>

        {/* Progress */}
        {status !== 'error' && (
          <div className="space-y-4">
            {/* Step indicators */}
            <div className="flex justify-center gap-6 text-xs text-slate-400">
              <span className={currentStep === 'git' ? 'text-brand-orange font-medium' : currentStep === 'python' || currentStep === 'done' ? 'text-emerald-500' : ''}>
                {currentStep === 'python' || currentStep === 'done' ? '\u2713 ' : ''}Git
              </span>
              <span className={currentStep === 'python' ? 'text-brand-orange font-medium' : currentStep === 'done' ? 'text-emerald-500' : ''}>
                {currentStep === 'done' ? '\u2713 ' : ''}Python
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-orange rounded-full transition-all duration-500 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>

            {/* Status message */}
            <p className="text-sm text-slate-600 animate-pulse">{message}</p>

            {/* Info text */}
            {status === 'installing' && (
              <p className="text-xs text-slate-400 mt-4">
                La instalacion es automatica y solo ocurre la primera vez.
              </p>
            )}
          </div>
        )}

        {/* Error state */}
        {status === 'error' && (
          <div className="space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {errorDetail}
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => window.open(
                  currentStep === 'git' ? 'https://git-scm.com/downloads' : 'https://www.python.org/downloads/',
                  '_blank',
                )}
                className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
              >
                Descargar {currentStep === 'git' ? 'Git' : 'Python'}
              </button>
              <button
                onClick={runSetup}
                className="px-4 py-2 text-sm bg-brand-orange text-white rounded-lg hover:bg-brand-orange/90"
              >
                Reintentar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
