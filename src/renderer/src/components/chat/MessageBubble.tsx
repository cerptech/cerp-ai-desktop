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
  const showToolDetails = hasTools && (!isStreaming || showThoughts)

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-white border border-slate-200 text-slate-800 px-4 py-3 shadow-sm">
        {/* Thinking loader (default during streaming) */}
        {showThinkingLoader && (
          <ThinkingLoader onToggleDetails={onToggleThoughts} onStop={onStop} />
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

        {/* Message content with markdown */}
        {message.content && (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}
