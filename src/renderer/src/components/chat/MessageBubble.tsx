import type { ChatMessage } from '@/hooks/useAgent'
import { ToolExecutions } from './ToolIndicator'
import { MarkdownContent } from './MarkdownContent'

interface MessageBubbleProps {
  message: ChatMessage
}

export function MessageBubble({ message }: MessageBubbleProps) {
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

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-white border border-slate-200 text-slate-800 px-4 py-3 shadow-sm">
        {/* Tool executions */}
        {message.tools && message.tools.length > 0 && (
          <ToolExecutions tools={message.tools} />
        )}

        {/* Message content with markdown */}
        {message.content && (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}
