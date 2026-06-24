import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/Button'
import { QUICK_ACTIONS } from '@/constants/quickActions'
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  ONBOARDING_EXAMPLES,
  ONBOARDING_CHECKLIST,
  ONBOARDING_GLOSSARY,
  ONBOARDING_NEXT_STEPS,
} from '@/constants/onboardingSteps'
import type { OnboardingProgress } from '../../../../preload/index'

interface OnboardingWizardProps {
  progress: OnboardingProgress
  onClose: () => void
  onViewStep: (step: number) => void
  onCompleteStep: (step: number) => void
  onSkip: () => void
  onComplete: () => void
  /** Opens the folder picker and wires the chosen folder to the chat. Returns the path. */
  onConnectFolder: () => Promise<string | null>
  /** Injects a pre-armed prompt into the chat input and closes the wizard. */
  onUsePrompt: (text: string) => void
}

export function OnboardingWizard({
  progress,
  onClose,
  onViewStep,
  onCompleteStep,
  onSkip,
  onComplete,
  onConnectFolder,
  onUsePrompt,
}: OnboardingWizardProps) {
  // Start where the user left off (clamped to a valid step).
  const [current, setCurrent] = useState<number>(
    Math.min(Math.max(progress.currentStep || 1, 1), ONBOARDING_TOTAL_STEPS),
  )
  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const [connectedFolder, setConnectedFolder] = useState<string | null>(null)

  const meta = ONBOARDING_STEPS[current - 1]
  const isFirst = current === 1
  const isLast = current === ONBOARDING_TOTAL_STEPS

  // Record a "view" each time the user lands on a step.
  useEffect(() => {
    onViewStep(current)
  }, [current, onViewStep])

  const goNext = useCallback(() => {
    onCompleteStep(current)
    if (isLast) {
      onComplete()
      onClose()
    } else {
      setCurrent((c) => Math.min(c + 1, ONBOARDING_TOTAL_STEPS))
    }
  }, [current, isLast, onCompleteStep, onComplete, onClose])

  const goBack = useCallback(() => setCurrent((c) => Math.max(c - 1, 1)), [])

  const handleConnect = useCallback(async () => {
    const path = await onConnectFolder()
    if (path) setConnectedFolder(path)
  }, [onConnectFolder])

  const handleUsePrompt = useCallback(
    (text: string) => {
      onCompleteStep(current)
      onUsePrompt(text)
      onClose()
    },
    [current, onCompleteStep, onUsePrompt, onClose],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="max-w-2xl w-full mx-4 bg-white rounded-2xl shadow-xl border border-slate-200 max-h-[88vh] flex flex-col">
        {/* Header: progress + skip */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400">
              Paso {current} de {ONBOARDING_TOTAL_STEPS}
            </span>
            {!confirmingSkip ? (
              <button
                onClick={() => setConfirmingSkip(true)}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Saltar tutorial
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">¿Seguro? Podés retomarlo desde "Cómo empezar".</span>
                <button
                  onClick={() => {
                    onSkip()
                    onClose()
                  }}
                  className="font-medium text-red-500 hover:text-red-600"
                >
                  Sí, saltar
                </button>
                <button
                  onClick={() => setConfirmingSkip(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  Cancelar
                </button>
              </div>
            )}
          </div>
          {/* Progress bar */}
          <div className="flex gap-1.5">
            {ONBOARDING_STEPS.map((s) => (
              <div
                key={s.id}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  s.id < current
                    ? 'bg-brand-orange'
                    : s.id === current
                      ? 'bg-brand-orange/60'
                      : 'bg-slate-200'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="text-3xl leading-none" role="img" aria-hidden>
              {meta.icon}
            </span>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">{meta.title}</h2>
              <p className="text-sm text-slate-500">{meta.tagline}</p>
            </div>
          </div>

          <StepBody
            step={current}
            connectedFolder={connectedFolder}
            onConnect={handleConnect}
            onUsePrompt={handleUsePrompt}
          />
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100">
          <button
            onClick={goBack}
            disabled={isFirst}
            className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-0 disabled:cursor-default transition-colors"
          >
            ← Atrás
          </button>
          <Button onClick={goNext}>{isLast ? 'Empezar a usar CERP AI' : 'Siguiente'}</Button>
        </div>
      </div>
    </div>
  )
}

// ── Per-step body content ───────────────────────────────────────────────────
interface StepBodyProps {
  step: number
  connectedFolder: string | null
  onConnect: () => void
  onUsePrompt: (text: string) => void
}

function StepBody({ step, connectedFolder, onConnect, onUsePrompt }: StepBodyProps) {
  switch (step) {
    case 1:
      return (
        <div className="grid sm:grid-cols-3 gap-3">
          {ONBOARDING_EXAMPLES.map((ex) => (
            <div key={ex.title} className="p-3 rounded-xl border border-slate-200 bg-slate-50/50">
              <span className="text-2xl" role="img" aria-hidden>
                {ex.icon}
              </span>
              <h3 className="text-sm font-medium text-slate-700 mt-2">{ex.title}</h3>
              <p className="text-xs text-slate-500 mt-1">{ex.description}</p>
            </div>
          ))}
        </div>
      )

    case 2:
      return (
        <div className="space-y-2">
          <p className="text-sm text-slate-600 mb-3">
            No necesitás todo, pero cuanto más completo, mejor cotiza la IA. El pliego o los archivos de
            la obra son lo más importante.
          </p>
          {ONBOARDING_CHECKLIST.map((item) => (
            <div key={item.label} className="flex items-start gap-3 p-3 rounded-xl border border-slate-200">
              <span className="mt-0.5 text-slate-300">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="4" />
                </svg>
              </span>
              <div>
                <span className="text-sm font-medium text-slate-700">
                  {item.label}
                  {item.required && <span className="ml-2 text-[10px] font-semibold text-brand-orange uppercase">Recomendado</span>}
                </span>
                <p className="text-xs text-slate-500">{item.hint}</p>
              </div>
            </div>
          ))}
        </div>
      )

    case 3:
      return (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            CERP AI trabaja sobre una carpeta local: ahí lee tus archivos y guarda lo que genera.
            Conectala una vez y la IA sabrá dónde buscar.
          </p>
          <ol className="text-sm text-slate-600 space-y-1.5 list-decimal list-inside">
            <li>Hacé click en <span className="font-medium">Conectar carpeta</span>.</li>
            <li>Elegí la carpeta donde están los archivos de tu obra.</li>
            <li>Listo: vas a verla indicada arriba del chat.</li>
          </ol>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={onConnect}>
              Conectar carpeta
            </Button>
            {connectedFolder && (
              <span className="text-xs text-emerald-600 font-mono truncate max-w-[280px]" title={connectedFolder}>
                ✓ {connectedFolder}
              </span>
            )}
          </div>
        </div>
      )

    case 4:
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Elegí un punto de partida. Se va a cargar en el chat para que lo edites antes de enviarlo.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {QUICK_ACTIONS.slice(0, 4).map((action) => (
              <button
                key={action.label}
                onClick={() => onUsePrompt(action.prompt)}
                className="text-left p-3 rounded-xl border border-slate-200 hover:border-brand-orange/40 hover:bg-orange-50/50 transition-all"
              >
                <span className="text-sm font-medium text-slate-700">{action.label}</span>
                <p className="text-xs text-slate-500 mt-1 line-clamp-2">{action.prompt}</p>
              </button>
            ))}
          </div>
        </div>
      )

    case 5:
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Cuando la IA termina, te devuelve un presupuesto estructurado. Estos son los términos clave:
          </p>
          <dl className="space-y-2">
            {ONBOARDING_GLOSSARY.map((g) => (
              <div key={g.term} className="p-3 rounded-xl border border-slate-200">
                <dt className="text-sm font-medium text-slate-700">{g.term}</dt>
                <dd className="text-xs text-slate-500 mt-0.5">{g.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )

    case 6:
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Ya estás listo. Algunas cosas que podés hacer ahora:</p>
          <ul className="space-y-2">
            {ONBOARDING_NEXT_STEPS.map((s) => (
              <li key={s} className="flex items-start gap-2.5 text-sm text-slate-600">
                <span className="mt-1 text-brand-orange">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )

    default:
      return null
  }
}
