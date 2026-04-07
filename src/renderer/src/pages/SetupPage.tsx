import { useState, useEffect, useCallback } from 'react'

interface SetupPageProps {
  onComplete: () => void
}

export function SetupPage({ onComplete }: SetupPageProps) {
  const [status, setStatus] = useState<'checking' | 'installing' | 'done' | 'error'>('checking')
  const [message, setMessage] = useState('Verificando entorno...')
  const [percent, setPercent] = useState(0)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)

  const runSetup = useCallback(async () => {
    // Step 1: Check Python
    setStatus('checking')
    setMessage('Verificando Python...')
    setPercent(5)

    const pythonStatus = await window.cerpAPI.checkPython()

    if (pythonStatus.installed && pythonStatus.pipInstalled) {
      setMessage(`Python encontrado: ${pythonStatus.version}`)
      setPercent(100)
      setStatus('done')
      // Small delay so user sees the success message
      setTimeout(onComplete, 800)
      return
    }

    // Step 2: Install Python
    setStatus('installing')
    setMessage('Preparando instalacion de Python...')
    setPercent(10)

    // Listen to progress events
    const unsub = window.cerpAPI.onPythonProgress((data) => {
      setMessage(data.message)
      setPercent(data.percent)
    })

    const success = await window.cerpAPI.installPython()
    unsub()

    if (success) {
      setStatus('done')
      setMessage('Entorno listo')
      setPercent(100)
      setTimeout(onComplete, 1000)
    } else {
      setStatus('error')
      setErrorDetail(
        'No se pudo instalar Python automaticamente. Por favor instala Python 3.12+ desde python.org y reinicia la app.',
      )
    }
  }, [onComplete])

  useEffect(() => {
    runSetup()
  }, [runSetup])

  return (
    <div className="flex items-center justify-center h-screen bg-slate-50">
      <div className="max-w-md w-full mx-4 text-center">
        {/* Logo */}
        <div className="mb-8">
          <div className="w-16 h-16 bg-brand-orange rounded-2xl mx-auto flex items-center justify-center mb-4">
            <span className="text-white text-2xl font-bold">C</span>
          </div>
          <h1 className="text-xl font-semibold text-slate-800">CERP AI</h1>
          <p className="text-sm text-slate-500 mt-1">Preparando tu entorno de trabajo</p>
        </div>

        {/* Progress */}
        {status !== 'error' && (
          <div className="space-y-4">
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
                CERP AI necesita Python para generar documentos PDF, Excel y analizar archivos de obra.
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
                onClick={() => window.open('https://www.python.org/downloads/', '_blank')}
                className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50"
              >
                Descargar Python
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
