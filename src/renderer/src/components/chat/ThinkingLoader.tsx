import { useState, useEffect } from 'react'

const THINKING_VERBS = [
  'Pensando',
  'Analizando',
  'Procesando',
  'Investigando',
  'Evaluando',
  'Consultando',
  'Revisando',
  'Calculando',
  'Organizando',
  'Preparando',
  'Verificando',
  'Comparando',
  'Sintetizando',
  'Interpretando',
  'Explorando',
  'Diseñando',
  'Planificando',
  'Optimizando',
  'Estructurando',
  'Razonando',
  'Refinando',
  'Contextualizando',
  'Deduciendo',
  'Formulando',
  'Considerando',
  'Profundizando',
  'Integrando',
  'Clasificando',
  'Elaborando',
  'Resolviendo',
  'Determinando',
  'Examinando',
  'Priorizando',
  'Articulando',
  'Identificando',
  'Modelando',
  'Iterando',
  'Consolidando',
  'Validando',
  'Construyendo',
  'Fundamentando',
  'Componiendo',
  'Correlacionando',
  'Dimensionando',
  'Trazando',
  'Estimando',
  'Coordinando',
  'Programando',
  'Catalogando',
  'Proyectando',
  'Balanceando',
  'Gestionando',
  'Conectando ideas',
  'Buscando patrones',
  'Generando opciones',
]

interface ThinkingLoaderProps {
  onToggleDetails?: () => void
  onStop?: () => void
}

export function ThinkingLoader({ onToggleDetails, onStop }: ThinkingLoaderProps) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length))
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % THINKING_VERBS.length)
        setVisible(true)
      }, 200)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2.5">
        <div className="flex gap-1">
          <span
            className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-bounce"
            style={{ animationDelay: '0ms', animationDuration: '1s' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-bounce"
            style={{ animationDelay: '150ms', animationDuration: '1s' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-bounce"
            style={{ animationDelay: '300ms', animationDuration: '1s' }}
          />
        </div>
        <span
          className={`text-xs text-slate-500 transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        >
          {THINKING_VERBS[index]}...
        </span>
      </div>
      <div className="flex items-center gap-3 mt-1.5">
        {onStop && (
          <button
            onClick={onStop}
            className="text-[10px] text-red-400 hover:text-red-600 transition-colors flex items-center gap-1"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            Detener
          </button>
        )}
        {onToggleDetails && (
          <button
            onClick={onToggleDetails}
            className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            Ver paso a paso
          </button>
        )}
      </div>
    </div>
  )
}
