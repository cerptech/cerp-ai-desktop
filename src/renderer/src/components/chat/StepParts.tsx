import { useState } from 'react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import type { SubagentStep, StepStatus } from '@/hooks/useAgent'
import { useElapsed, formatDuration } from '@/hooks/useElapsed'
import { SLOW_STEP_NOTICE_MS } from '@/stores/stepLifecycle'
import { getToolHumanLabel, formatToolInput, summarizeToolOutput } from '@/utils/toolUtils'

/**
 * Piezas de un paso del agente que comparten las tarjetas del chat (ToolIndicator) y el
 * panel lateral de agentes (AgentsPanel): ícono de estado, contador, aviso de paso lento
 * y la fila de un paso de subagente. Mismo lenguaje visual en los dos lugares.
 */

export function ElapsedTime({ elapsed }: { elapsed: number }) {
  return <span className="text-[10px] text-slate-400 ml-2">{formatDuration(elapsed)}</span>
}

/**
 * Paso (no delegación) corriendo hace más de SLOW_STEP_NOTICE_MS: se avisa y se ofrece
 * el mismo Detener del loader, para que nadie espere a ciegas al watchdog del main.
 */
export function SlowStepNotice({ onStop }: { onStop?: () => void }) {
  return (
    <div className="flex items-center gap-2 mt-0.5 ml-6 text-[10px] text-amber-600">
      <span>Este paso está tardando más de lo normal</span>
      {onStop && (
        <button
          onClick={onStop}
          className="font-medium text-red-400 hover:text-red-600 transition-colors"
        >
          Detener
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step status icons
// ---------------------------------------------------------------------------

export function StepStatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') {
    return <LoadingSpinner size="sm" />
  }
  if (status === 'interrupted') {
    // Neutro: el turno se cerró sin que llegara el resultado de este paso (no es un error suyo).
    return (
      <svg
        className="w-4 h-4 text-slate-400 shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-label="Interrumpido"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"
          clipRule="evenodd"
        />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg
        className="w-4 h-4 text-error shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-label="Error"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
          clipRule="evenodd"
        />
      </svg>
    )
  }
  // done
  return (
    <svg
      className="w-4 h-4 text-success shrink-0"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-label="Completado"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// SubagentStepRow — a single inner tool call from a delegated subagent
// ---------------------------------------------------------------------------

export function SubagentStepRow({ step, onStop }: { step: SubagentStep; onStop?: () => void }) {
  const [showOutput, setShowOutput] = useState(false)
  const running = step.status === 'running'
  const interrupted = step.status === 'interrupted'
  const elapsed = useElapsed(step.startTime, running)
  // Interrumpido: sin duración (contaría hasta el cierre del turno, no lo que tardó el paso).
  const duration = !interrupted && step.endTime && step.startTime ? step.endTime - step.startTime : null
  const label = getToolHumanLabel(step.name)
  const inputFormatted = formatToolInput(step.name, step.input)
  const outputSummary = !running && !interrupted ? summarizeToolOutput(step.name, step.output) : null
  const slow = running && !step.awaitingUser && elapsed >= SLOW_STEP_NOTICE_MS

  return (
    <div>
      <button
        onClick={() => step.output ? setShowOutput(!showOutput) : undefined}
        className={`flex items-start gap-1.5 text-left w-full ${step.output ? 'hover:text-slate-700 cursor-pointer' : 'cursor-default'} transition-colors py-0.5`}
        title={inputFormatted?.tooltip}
      >
        <span className="shrink-0 mt-0.5">
          <StepStatusIcon status={step.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span className={`text-[11px] font-medium ${step.status === 'error' ? 'text-error' : running ? 'text-brand-orange' : 'text-slate-500'}`}>
              {label}
            </span>
            {duration !== null && (
              <span className="text-[10px] text-slate-400">{formatDuration(duration)}</span>
            )}
            {interrupted && <span className="text-[10px] text-slate-400">Interrumpido</span>}
            {running && step.awaitingUser && <span className="text-[10px] text-slate-400">Esperando tu respuesta</span>}
            {running && !step.awaitingUser && <ElapsedTime elapsed={elapsed} />}
          </div>
          {inputFormatted && (
            <span
              className="block mt-0 font-mono text-[10px] text-slate-400 truncate max-w-[340px]"
              title={inputFormatted.tooltip ?? inputFormatted.display}
            >
              {inputFormatted.display}
            </span>
          )}
          {outputSummary && (
            <span className="block text-[10px] text-slate-400 italic">{outputSummary}</span>
          )}
        </div>
      </button>
      {slow && <SlowStepNotice onStop={onStop} />}
      {showOutput && step.output && (
        <pre className="mt-1 ml-5 p-2 bg-slate-900 text-slate-300 rounded-md text-[10px] font-mono overflow-x-auto max-h-32 overflow-y-auto leading-relaxed">
          {step.output}
        </pre>
      )}
    </div>
  )
}
