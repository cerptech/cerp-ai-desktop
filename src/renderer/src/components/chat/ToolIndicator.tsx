import { useState } from 'react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { AGENTS } from '@/components/agents/agentConfig'
import type { ToolExecution } from '@/hooks/useAgent'
import { SLOW_STEP_NOTICE_MS, isDelegationTool } from '@/stores/stepLifecycle'
import { useElapsed, formatDuration } from '@/hooks/useElapsed'
import { ElapsedTime, SlowStepNotice, StepStatusIcon, SubagentStepRow } from './StepParts'
import {
  getToolHumanLabel,
  getVagueActivityLabel,
  formatToolInput,
  summarizeToolOutput,
} from '@/utils/toolUtils'

// ---------------------------------------------------------------------------
// ToolStep — a single orchestrator-level tool, with optional nested subagent steps
// ---------------------------------------------------------------------------

interface ToolStepProps {
  tool: ToolExecution
  /** El turno de la conversación sigue vivo (streaming o pendiente). */
  turnActive?: boolean
  /** Detener del turno (el abort existente); solo en la burbuja que está corriendo. */
  onStop?: () => void
}

function ToolStep({ tool, turnActive, onStop }: ToolStepProps) {
  const [showOutput, setShowOutput] = useState(false)
  const [subStepsExpanded, setSubStepsExpanded] = useState(true)
  // Etiquetas de actividad en lenguaje de obra (Ola 2): mientras la tool corre
  // se muestra una frase vaga ("Consultando presupuestos…"), sin parámetros.
  // El detalle técnico (nombre real + input) queda un click de distancia.
  const [showTechnical, setShowTechnical] = useState(false)
  const running = tool.status === 'running'
  const interrupted = tool.status === 'interrupted'
  const elapsed = useElapsed(tool.startTime, running)
  // Interrumpido: sin duración (contaría hasta el cierre del turno, no lo que tardó el paso).
  const duration = !interrupted && tool.endTime && tool.startTime ? tool.endTime - tool.startTime : null

  const isAgentTool = isDelegationTool(tool.name)
  const isVagueRunning = !isAgentTool && tool.status === 'running' && !showTechnical
  const slow = running && !isAgentTool && !tool.awaitingUser && elapsed >= SLOW_STEP_NOTICE_MS

  // Resolve agent name for Agent/Task delegation tools
  const resolvedAgentName = isAgentTool && tool.agentName
    ? (AGENTS.find((a) => a.name === tool.agentName)?.label ?? tool.agentName)
    : undefined

  const subSteps = tool.subagentSteps ?? []
  const subStepsRunning = subSteps.filter((s) => s.status === 'running').length
  const subStepsDone = subSteps.filter((s) => s.status !== 'running').length
  const hasSubSteps = subSteps.length > 0

  // Label for Agent/Task tools — show step count while running
  let label: string
  if (resolvedAgentName) {
    if (tool.status === 'running') {
      label = hasSubSteps
        ? `${resolvedAgentName} · ${subSteps.length} paso${subSteps.length !== 1 ? 's' : ''} · trabajando...`
        : `Delegando a ${resolvedAgentName}`
    } else {
      label = hasSubSteps
        ? `${resolvedAgentName} · ${subSteps.length} paso${subSteps.length !== 1 ? 's' : ''}`
        : `${resolvedAgentName}`
    }
  } else if (tool.status === 'running' && tool.awaitingUser) {
    label = 'Esperando tu respuesta'
  } else if (isVagueRunning) {
    label = getVagueActivityLabel(tool.name, tool.agentName)
  } else {
    label = getToolHumanLabel(tool.name, tool.agentName)
  }

  const inputFormatted = isAgentTool || isVagueRunning ? null : formatToolInput(tool.name, tool.input)
  const outputSummary =
    !running && !interrupted && !isAgentTool ? summarizeToolOutput(tool.name, tool.output) : null

  const labelColor =
    tool.status === 'error'
      ? 'text-error'
      : running
        ? 'text-brand-orange'
        : interrupted
          ? 'text-slate-500'
          : 'text-slate-600'

  return (
    <div>
      <button
        onClick={() => {
          if (isAgentTool && hasSubSteps) {
            setSubStepsExpanded(!subStepsExpanded)
          } else if (!isAgentTool && tool.status === 'running') {
            setShowTechnical(!showTechnical)
          } else if (tool.output) {
            setShowOutput(!showOutput)
          }
        }}
        className={`flex items-start gap-2 text-left w-full ${(isAgentTool && hasSubSteps) || tool.output || (!isAgentTool && tool.status === 'running') ? 'hover:text-slate-700 cursor-pointer' : 'cursor-default'} transition-colors`}
        title={isVagueRunning ? 'Ver detalle técnico' : inputFormatted?.tooltip}
      >
        {/* Status icon */}
        <span className="shrink-0 mt-0.5">
          <StepStatusIcon status={tool.status} />
        </span>

        <div className="min-w-0 flex-1">
          {/* Label row */}
          <div className="flex items-center gap-1 flex-wrap">
            {/* Expand/collapse indicator for delegation tools with sub-steps */}
            {isAgentTool && hasSubSteps && (
              <span className={`text-[10px] text-slate-400 transition-transform duration-150 ${subStepsExpanded ? 'rotate-90' : ''}`}>
                &#9654;
              </span>
            )}
            <span className={`text-xs font-medium ${labelColor}`}>{label}</span>
            {duration !== null && (
              <span className="text-[10px] text-slate-400">{formatDuration(duration)}</span>
            )}
            {interrupted && <span className="text-[10px] text-slate-400">Interrumpido</span>}
            {running && !hasSubSteps && !tool.awaitingUser && <ElapsedTime elapsed={elapsed} />}
            {running && hasSubSteps && subStepsRunning > 0 && (
              <LoadingSpinner size="sm" />
            )}
          </div>

          {/* Input hint (non-agent tools) */}
          {inputFormatted && (
            <span
              className="block mt-0.5 font-mono text-[11px] text-slate-400 truncate max-w-[380px]"
              title={inputFormatted.tooltip ?? inputFormatted.display}
            >
              {inputFormatted.display}
            </span>
          )}

          {/* Output summary (done non-agent steps) */}
          {outputSummary && (
            <span className="block mt-0.5 text-[10px] text-slate-400 italic">
              {outputSummary}
            </span>
          )}

          {/* Subagent live reasoning text (Fase 2, forwardSubagentText) */}
          {isAgentTool && tool.status === 'running' && tool.subagentText && (
            <span className="block mt-0.5 text-[10px] text-slate-400 italic truncate max-w-[380px]">
              {tool.subagentText.split('\n')[0].slice(0, 120)}
            </span>
          )}
        </div>
      </button>

      {slow && <SlowStepNotice onStop={onStop} />}

      {/* Nested subagent steps — indented, expandable */}
      {isAgentTool && hasSubSteps && subStepsExpanded && (
        <div className="ml-6 mt-1 border-l border-slate-200 pl-3 space-y-0.5">
          {subSteps.map((step, i) => (
            <SubagentStepRow key={`${step.name}-${i}`} step={step} onStop={onStop} />
          ))}
          {/* Summary of finished sub-steps while still running: solo con la delegación Y el
              turno vivos. Un turno cerrado ya no espera nada (su tarjeta quedó cerrada). */}
          {running && turnActive && subStepsDone > 0 && subStepsRunning === 0 && (
            <span className="block text-[10px] text-slate-400 italic pt-0.5">
              {subStepsDone} paso{subStepsDone !== 1 ? 's' : ''} completado{subStepsDone !== 1 ? 's' : ''} · esperando resultado...
            </span>
          )}
        </div>
      )}

      {/* Expandable raw output (non-agent tools) */}
      {!isAgentTool && showOutput && tool.output && (
        <pre className="mt-1 ml-6 p-2 bg-slate-900 text-slate-300 rounded-md text-[10px] font-mono overflow-x-auto max-h-40 overflow-y-auto leading-relaxed">
          {tool.output}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ToolExecutions — main export
// ---------------------------------------------------------------------------

interface ToolExecutionsProps {
  tools: ToolExecution[]
  /** True when the parent agent is still streaming (used for fix #6) */
  isStreaming?: boolean
  /** El turno de la conversación sigue vivo (aunque esta no sea la última burbuja). */
  turnActive?: boolean
  /** Detener del turno: se ofrece en los pasos que tardan más de lo normal. */
  onStop?: () => void
}

export function ToolExecutions({ tools, isStreaming, turnActive, onStop }: ToolExecutionsProps) {
  const [expanded, setExpanded] = useState(false)

  if (!tools.length) return null

  const running = tools.filter((t) => t.status === 'running')
  const finished = tools.filter((t) => t.status !== 'running') // done + error + interrupted
  const errorCount = tools.filter((t) => t.status === 'error').length
  const interruptedCount = tools.filter((t) => t.status === 'interrupted').length
  const interruptedSuffix = interruptedCount > 0
    ? `${interruptedCount} interrumpido${interruptedCount > 1 ? 's' : ''}`
    : null

  return (
    <div className="mb-3 text-xs">
      {/* Active tools */}
      {running.map((tool, i) => (
        <div key={`r-${i}`} className="flex items-start gap-2 py-1.5">
          <ToolStep tool={tool} turnActive={turnActive ?? isStreaming} onStop={onStop} />
        </div>
      ))}

      {/* Finished tools — collapsible summary */}
      {finished.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 py-1 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <span
              className={`text-[10px] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            >
              &#9654;
            </span>

            {/* Fix #6: while still streaming, show "working" indicator not green check */}
            {isStreaming ? (
              <>
                <LoadingSpinner size="sm" />
                <span>
                  {finished.length} paso{finished.length > 1 ? 's' : ''} · trabajando...
                </span>
              </>
            ) : errorCount > 0 ? (
              <>
                <span className="text-error text-[10px]">&#10007;</span>
                <span>
                  {finished.length} paso{finished.length > 1 ? 's' : ''} completado{finished.length > 1 ? 's' : ''}
                  {' '}({errorCount} error{errorCount > 1 ? 'es' : ''}{interruptedSuffix ? `, ${interruptedSuffix}` : ''})
                </span>
              </>
            ) : interruptedSuffix ? (
              <>
                <span className="text-slate-400 text-[10px]">&#8212;</span>
                <span>
                  {finished.length} paso{finished.length > 1 ? 's' : ''} ({interruptedSuffix})
                </span>
              </>
            ) : (
              <>
                <span className="text-success text-[10px]">&#10003;</span>
                <span>
                  {finished.length} paso{finished.length > 1 ? 's' : ''} completado{finished.length > 1 ? 's' : ''}
                </span>
              </>
            )}
          </button>

          {expanded && (
            <div className="ml-4 mt-1 border-l border-slate-200 pl-3 space-y-1.5">
              {finished.map((tool, i) => (
                <ToolStep key={i} tool={tool} turnActive={turnActive ?? isStreaming} onStop={onStop} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
