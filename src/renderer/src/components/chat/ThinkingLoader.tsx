import { useState, useEffect } from 'react'
import { SDK_IDLE_NOTICE_MS, SLOW_STEP_NOTICE_MS } from '@/stores/stepLifecycle'

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

const AGENT_LABELS: Record<string, string> = {
  'cerp-data': 'Consultando datos de CERP',
  'excel-analyst': 'Analizando archivos Excel',
  'revit-bim': 'Procesando modelo BIM',
  'autocad-agent': 'Leyendo planos AutoCAD',
  'sketchup-agent': 'Analizando modelo SketchUp',
  'architecture': 'Revisando documentación técnica',
  'report-generator': 'Generando documento',
}

interface ThinkingLoaderProps {
  onToggleDetails?: () => void
  onStop?: () => void
  /** Name of the active delegated agent, if any */
  activeAgentName?: string
  /**
   * Inicio del paso corriendo más antiguo que no es una delegación (oldestRunningStepStart):
   * pasados SLOW_STEP_NOTICE_MS el loader avisa que está tardando más de lo normal.
   */
  slowStepSince?: number | null
  /** Hace cuánto el SDK no manda nada, según el heartbeat del main (0 = hay actividad). */
  sdkIdleMs?: number
}

/** «hace N min» redondeado hacia abajo, mínimo 1. */
function minutesAgo(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000))
}

export function ThinkingLoader({ onToggleDetails, onStop, activeAgentName, slowStepSince, sdkIdleMs = 0 }: ThinkingLoaderProps) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length))
  const [visible, setVisible] = useState(true)
  // Reloj para el aviso de paso lento: solo corre si hay un paso que vigilar.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (slowStepSince == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [slowStepSince])
  const slowStep = slowStepSince != null && now - slowStepSince >= SLOW_STEP_NOTICE_MS
  const sdkIdle = sdkIdleMs >= SDK_IDLE_NOTICE_MS

  useEffect(() => {
    // Don't rotate verbs when showing a specific agent label
    if (activeAgentName) return

    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % THINKING_VERBS.length)
        setVisible(true)
      }, 200)
    }, 3000)
    return () => clearInterval(interval)
  }, [activeAgentName])

  const displayText = activeAgentName
    ? AGENT_LABELS[activeAgentName] || `Trabajando con ${activeAgentName}`
    : `${THINKING_VERBS[index]}...`

  return (
    <div className="py-1.5">
      <div role="status" className="flex items-center gap-2.5">
        <span className="sr-only">{displayText}</span>
        <div className="flex gap-1" aria-hidden="true">
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
          className={`text-xs transition-opacity duration-200 ${
            activeAgentName ? 'text-brand-orange font-medium opacity-100' : `text-slate-500 ${visible ? 'opacity-100' : 'opacity-0'}`
          }`}
        >
          {displayText}
        </span>
      </div>
      {/* Avisos de espera larga: el usuario ve que algo no avanza y tiene el Detener a mano,
          en vez de esperar a ciegas a que el main corte el turno (15 min sin actividad). */}
      {(slowStep || sdkIdle) && (
        <div className="mt-1 text-[10px] text-amber-600">
          {slowStep && <span>Este paso está tardando más de lo normal</span>}
          {slowStep && sdkIdle && <span> · </span>}
          {sdkIdle && <span>Sin actividad hace {minutesAgo(sdkIdleMs)} min</span>}
        </div>
      )}
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
            Ver detalles
          </button>
        )}
      </div>
    </div>
  )
}
