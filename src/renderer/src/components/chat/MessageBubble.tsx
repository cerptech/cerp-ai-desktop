import { useState } from 'react'
import type { ChatMessage } from '@/hooks/useAgent'
import { ToolExecutions } from './ToolIndicator'
import { MarkdownContent } from './MarkdownContent'
import { ThinkingLoader } from './ThinkingLoader'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

interface MessageBubbleProps {
  message: ChatMessage
  /** True only for the last assistant message while agent is streaming */
  isStreaming?: boolean
  /** Whether to show detailed tool executions instead of the thinking loader */
  showThoughts?: boolean
  /** Callback to toggle showThoughts */
  onToggleThoughts?: () => void
  /** Callback to abort the running agent */
  onStop?: () => void
  /** Reenvía el último prompt del usuario (Ola 1) — solo se pasa en el último mensaje del asistente */
  onRegenerate?: () => void
  /** True mientras hay un turno en vuelo (cualquier conversación en esta pestaña) */
  regenerateDisabled?: boolean
}

// ---------------------------------------------------------------------------
// CopyMessageButton — copies the full message text to clipboard
// ---------------------------------------------------------------------------

interface CopyMessageButtonProps {
  text: string
}

function CopyMessageButton({ text }: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      onClick={handleCopy}
      aria-label="Copiar mensaje"
      title="Copiar mensaje"
      className={[
        'flex items-center gap-1 rounded px-1.5 py-1',
        'text-[10px] transition-all duration-150',
        'bg-white/80 border border-slate-200 shadow-sm',
        copied
          ? 'text-emerald-500 opacity-100'
          : 'text-slate-400 opacity-0 group-hover:opacity-100 hover:text-slate-600',
      ].join(' ')}
    >
      {copied ? (
        <>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copiado
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copiar
        </>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// RegenerateButton — reenvía el último prompt del usuario (Ola 1)
// ---------------------------------------------------------------------------

interface RegenerateButtonProps {
  onClick: () => void
  disabled?: boolean
}

function RegenerateButton({ onClick, disabled }: RegenerateButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Regenerar respuesta"
      title={disabled ? 'Esperá a que termine la respuesta actual' : 'Regenerar respuesta'}
      className={[
        'flex items-center gap-1 rounded px-1.5 py-1',
        'text-[10px] transition-all duration-150',
        'bg-white/80 border border-slate-200 shadow-sm',
        'text-slate-400 opacity-0 group-hover:opacity-100 hover:text-slate-600',
        'disabled:cursor-not-allowed disabled:hover:text-slate-400',
      ].join(' ')}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4.5 9a8 8 0 0113.5-3.5L20 8M19.5 15a8 8 0 01-13.5 3.5L4 16" />
      </svg>
      Regenerar
    </button>
  )
}

// ---------------------------------------------------------------------------
// StreamingCursor — blinking pipe shown at the end of streaming content
// Uses CSS animation defined in tailwind.css (@keyframes blink-cursor).
// ---------------------------------------------------------------------------

function StreamingCursor() {
  return <span className="streaming-cursor text-slate-500" aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// MessageBubble — main export
// ---------------------------------------------------------------------------

export function MessageBubble({ message, isStreaming, showThoughts, onToggleThoughts, onStop, onRegenerate, regenerateDisabled }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  if (isUser) {
    // Burbuja asimétrica (converge con ai.cerp.es): usuario a la derecha con
    // fondo gris claro, sin burbuja del lado del asistente (ver más abajo).
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-[#f4f5f7] px-4 py-2.5 text-[15px] leading-relaxed text-brand-black whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }

  const hasTools = message.tools && message.tools.length > 0
  const showThinkingLoader = isStreaming && !showThoughts && (hasTools || !message.content)
  const showToolDetails = hasTools && showThoughts

  // Find active agent delegation for context in ThinkingLoader
  const activeAgent = message.tools?.find((t) => t.status === 'running' && t.name === 'Agent')

  // Show copy button only when there's actual text content and not streaming
  const showCopyButton = !!message.content && !isStreaming

  return (
    <div className="flex justify-start mb-5">
      {/* Sin burbuja del lado del asistente (converge con ai.cerp.es): texto
          suelto a ancho completo, `group` habilita el hover de los botones. */}
      <div className="relative group w-full text-[15px] leading-relaxed text-brand-black">

        {/* Copy + Regenerate buttons (hover reveal, top-right) */}
        {(showCopyButton || onRegenerate) && (
          <div className="absolute top-2 right-2 flex items-center gap-1">
            {onRegenerate && <RegenerateButton onClick={onRegenerate} disabled={regenerateDisabled} />}
            {showCopyButton && <CopyMessageButton text={message.content} />}
          </div>
        )}

        {/* Thinking loader (default during streaming, when showThoughts is off) */}
        {showThinkingLoader && (
          <ThinkingLoader
            onToggleDetails={onToggleThoughts}
            onStop={onStop}
            activeAgentName={activeAgent?.agentName}
          />
        )}

        {/* Detailed tool executions (opt-in via showThoughts) */}
        {showToolDetails && (
          <div>
            {isStreaming && onToggleThoughts && (
              <button
                onClick={onToggleThoughts}
                className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors mb-1"
              >
                {/* Fix #9: "Ocultar detalles" when expanded */}
                Ocultar detalles
              </button>
            )}
            {/* Fix #1/#5/#6: pass isStreaming so ToolExecutions knows if agent is still active */}
            <ToolExecutions tools={message.tools!} isStreaming={isStreaming} />
          </div>
        )}

        {/* Fallback: showThoughts mode but no tools and no content yet */}
        {isStreaming && showThoughts && !hasTools && !message.content && (
          <div className="flex items-center gap-2 py-1.5">
            <LoadingSpinner size="sm" />
            <span className="text-xs text-slate-400 animate-pulse">Pensando...</span>
          </div>
        )}

        {/* Collapsed tool summary when panel is closed and not streaming */}
        {hasTools && !showThinkingLoader && !showToolDetails && !isStreaming && (
          <button
            onClick={onToggleThoughts}
            className="text-[10px] text-slate-400 hover:text-slate-500 transition-colors mb-2 flex items-center gap-1"
          >
            <span className="text-success">&#10003;</span>
            {/* Fix #9: consistent label */}
            {message.tools!.length} paso{message.tools!.length > 1 ? 's' : ''} · Ver detalles
          </button>
        )}

        {/* Message content with markdown */}
        {message.content && (
          <div className="relative">
            <MarkdownContent content={message.content} />
            {/* Fix #7: blinking cursor at end of streaming content */}
            {isStreaming && <StreamingCursor />}
          </div>
        )}
      </div>
    </div>
  )
}
