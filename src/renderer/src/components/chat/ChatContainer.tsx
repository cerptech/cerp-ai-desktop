import { useState, useRef, useEffect } from 'react'
import { useAgent } from '@/hooks/useAgent'
import { MessageBubble } from './MessageBubble'
import { ToolIndicator } from './ToolIndicator'
import { QuickActions } from './QuickActions'
import { Button } from '@/components/ui/Button'

interface ChatContainerProps {
  userName?: string
}

export function ChatContainer({ userName }: ChatContainerProps) {
  const { messages, isStreaming, activeTool, error, sendPrompt, abort, clearMessages } = useAgent()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTool])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    setInput('')
    sendPrompt(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleQuickAction = (prompt: string) => {
    sendPrompt(prompt)
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-8">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                Hola{userName ? ` ${userName.split(' ')[0]}` : ''}, soy CERP AI
              </h2>
              <p className="text-slate-500 text-sm">
                Tu asistente inteligente para gestionar tu empresa constructora
              </p>
            </div>
            <QuickActions onSelect={handleQuickAction} disabled={isStreaming} />
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {activeTool && <ToolIndicator toolName={activeTool} />}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-slate-200 px-6 py-4">
        <form onSubmit={handleSubmit} className="flex items-end gap-3">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Pregunta lo que necesites sobre tus proyectos..."
              rows={1}
              className="w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
              disabled={isStreaming}
            />
          </div>
          {isStreaming ? (
            <Button variant="secondary" onClick={abort} type="button">
              Cancelar
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              Enviar
            </Button>
          )}
        </form>
        {messages.length > 0 && !isStreaming && (
          <div className="mt-2 flex justify-end">
            <button
              onClick={clearMessages}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              Nueva conversacion
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
