import { useState, useEffect } from 'react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { AGENTS } from '@/components/agents/agentConfig'
import type { ToolExecution, SubagentStep } from '@/hooks/useAgent'
import {
  getToolHumanLabel,
  formatToolInput,
  summarizeToolOutput,
} from '@/utils/toolUtils'

// ---------------------------------------------------------------------------
// Elapsed time counter (only used while a tool is running)
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const secs = ms / 1000
  if (secs < 1) return '<1s'
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = Math.floor(secs % 60)
  return `${mins}m ${remainSecs}s`
}

function ElapsedTime({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startTime)
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startTime), 1000)
    return () => clearInterval(id)
  }, [startTime])
  return <span className="text-[10px] text-slate-400 ml-2">{formatDuration(elapsed)}</span>
}

// ---------------------------------------------------------------------------
// Step status icons
// ---------------------------------------------------------------------------

function StepStatusIcon({ status }: { status: ToolExecution['status'] }) {
  if (status === 'running') {
    return <LoadingSpinner size="sm" />
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
// Individual step row (used in expanded list)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SubagentStepRow — a single inner tool call from a delegated subagent
// ---------------------------------------------------------------------------

function SubagentStepRow({ step }: { step: SubagentStep }) {
  const [showOutput, setShowOutput] = useState(false)
  const duration = step.endTime && step.startTime ? step.endTime - step.startTime : null
  const label = getToolHumanLabel(step.name)
  const inputFormatted = formatToolInput(step.name, step.input)
  const outputSummary = step.status !== 'running' ? summarizeToolOutput(step.name, step.output) : null

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
            <span className={`text-[11px] font-medium ${step.status === 'error' ? 'text-error' : step.status === 'running' ? 'text-brand-orange' : 'text-slate-500'}`}>
              {label}
            </span>
            {duration !== null && (
              <span className="text-[10px] text-slate-400">{formatDuration(duration)}</span>
            )}
            {step.status === 'running' && <ElapsedTime startTime={step.startTime} />}
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
      {showOutput && step.output && (
        <pre className="mt-1 ml-5 p-2 bg-slate-900 text-slate-300 rounded-md text-[10px] font-mono overflow-x-auto max-h-32 overflow-y-auto leading-relaxed">
          {step.output}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ToolStep — a single orchestrator-level tool, with optional nested subagent steps
// ---------------------------------------------------------------------------

function ToolStep({ tool }: { tool: ToolExecution }) {
  const [showOutput, setShowOutput] = useState(false)
  const [subStepsExpanded, setSubStepsExpanded] = useState(true)
  const duration = tool.endTime && tool.startTime ? tool.endTime - tool.startTime : null

  const isAgentTool = tool.name === 'Agent' || tool.name === 'Task'

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
  } else {
    label = getToolHumanLabel(tool.name, tool.agentName)
  }

  const inputFormatted = isAgentTool ? null : formatToolInput(tool.name, tool.input)
  const outputSummary =
    tool.status !== 'running' && !isAgentTool ? summarizeToolOutput(tool.name, tool.output) : null

  const labelColor =
    tool.status === 'error'
      ? 'text-error'
      : tool.status === 'running'
        ? 'text-brand-orange'
        : 'text-slate-600'

  return (
    <div>
      <button
        onClick={() => {
          if (isAgentTool && hasSubSteps) {
            setSubStepsExpanded(!subStepsExpanded)
          } else if (tool.output) {
            setShowOutput(!showOutput)
          }
        }}
        className={`flex items-start gap-2 text-left w-full ${(isAgentTool && hasSubSteps) || tool.output ? 'hover:text-slate-700 cursor-pointer' : 'cursor-default'} transition-colors`}
        title={inputFormatted?.tooltip}
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
            {tool.status === 'running' && !hasSubSteps && <ElapsedTime startTime={tool.startTime} />}
            {tool.status === 'running' && hasSubSteps && subStepsRunning > 0 && (
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

      {/* Nested subagent steps — indented, expandable */}
      {isAgentTool && hasSubSteps && subStepsExpanded && (
        <div className="ml-6 mt-1 border-l border-slate-200 pl-3 space-y-0.5">
          {subSteps.map((step, i) => (
            <SubagentStepRow key={`${step.name}-${i}`} step={step} />
          ))}
          {/* Summary of finished sub-steps while still running */}
          {tool.status === 'running' && subStepsDone > 0 && subStepsRunning === 0 && (
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
}

export function ToolExecutions({ tools, isStreaming }: ToolExecutionsProps) {
  const [expanded, setExpanded] = useState(false)

  if (!tools.length) return null

  const running = tools.filter((t) => t.status === 'running')
  const finished = tools.filter((t) => t.status !== 'running') // done + error
  const errorCount = tools.filter((t) => t.status === 'error').length

  return (
    <div className="mb-3 text-xs">
      {/* Active tools */}
      {running.map((tool, i) => (
        <div key={`r-${i}`} className="flex items-start gap-2 py-1.5">
          <ToolStep tool={tool} />
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
                  {' '}({errorCount} error{errorCount > 1 ? 'es' : ''})
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
                <ToolStep key={i} tool={tool} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
