import type { ChatMessage } from '@/hooks/useAgent'

interface MessageBubbleProps {
  message: ChatMessage
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-brand-orange text-white rounded-br-md'
            : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
        }`}
      >
        <div className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</div>
      </div>
    </div>
  )
}
