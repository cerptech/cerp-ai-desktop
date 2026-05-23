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
        'absolute top-2 right-2 flex items-center gap-1 rounded px-1.5 py-1',
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
// MessageBubble — main export
// ---------------------------------------------------------------------------

export function MessageBubble({ message, isStreaming, showThoughts, onToggleThoughts, onStop }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-brand-orange text-white px-4 py-3">
          <div className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</div>
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
    <div className="flex justify-start mb-4">
      {/* group class enables hover-based opacity on CopyMessageButton */}
      <div className="relative group max-w-[90%] rounded-2xl rounded-bl-md bg-white border border-slate-200 text-slate-800 px-4 py-3 shadow-sm">

        {/* Copy message button (hover reveal, top-right) */}
        {showCopyButton && <CopyMessageButton text={message.content} />}

        {/* Thinking loader (default during streaming) */}
        {showThinkingLoader && (
          <ThinkingLoader
            onToggleDetails={onToggleThoughts}
            onStop={onStop}
            activeAgentName={activeAgent?.agentName}
          />
        )}

        {/* Detailed tool executions (opt-in during streaming, always after) */}
        {showToolDetails && (
          <div>
            {isStreaming && onToggleThoughts && (
              <button
                onClick={onToggleThoughts}
                className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors mb-1"
              >
                Ocultar detalles
              </button>
            )}
            <ToolExecutions tools={message.tools!} />
          </div>
        )}

        {/* Fallback: showThoughts mode but no tools and no content yet */}
        {isStreaming && showThoughts && !hasTools && !message.content && (
          <div className="flex items-center gap-2 py-1.5">
            <LoadingSpinner size="sm" />
            <span className="text-xs text-slate-400 animate-pulse">Pensando...</span>
          </div>
        )}

        {/* Collapsed tool summary when hidden */}
        {hasTools && !showThinkingLoader && !showToolDetails && !isStreaming && (
          <button
            onClick={onToggleThoughts}
            className="text-[10px] text-slate-400 hover:text-slate-500 transition-colors mb-2 flex items-center gap-1"
          >
            <span className="text-emerald-500">&#10003;</span>
            {message.tools!.length} paso{message.tools!.length > 1 ? 's' : ''}
          </button>
        )}

        {/* Message content with markdown */}
        {message.content && (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}
