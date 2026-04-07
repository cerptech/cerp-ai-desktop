import { useState, useRef, useEffect, useCallback, DragEvent, MutableRefObject } from 'react'
import { useAgent, type ChatMessage } from '@/hooks/useAgent'
import { MessageBubble } from './MessageBubble'
import { QuickActions } from './QuickActions'
import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ThinkingLoader } from './ThinkingLoader'
import { useToast } from '@/hooks/useToast'

export interface ChatStateSnapshot {
  isStreaming: boolean
  messages: ChatMessage[]
  abort: () => Promise<void>
}

interface ChatContainerProps {
  userName?: string
  activeContextId?: string | null
  onAgentActivity: (agentName: string, status: 'active' | 'done' | 'idle') => void
  onNewConversation: () => void
  onMessageComplete?: (message: ChatMessage) => void
  restoreMessagesRef?: MutableRefObject<((msgs: ChatMessage[]) => void) | null>
  clearMessagesRef?: MutableRefObject<(() => void) | null>
  chatStateRef?: MutableRefObject<ChatStateSnapshot | null>
}

export function ChatContainer({ userName, activeContextId, onAgentActivity, onNewConversation, onMessageComplete, restoreMessagesRef, clearMessagesRef, chatStateRef }: ChatContainerProps) {
  const { messages, isStreaming, activeTool, activeAgentDelegation, promptSuggestions, error, sendPrompt, abort, clearMessages, restoreMessages } = useAgent()
  const { addToast } = useToast()
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showThoughts, setShowThoughts] = useState(() => localStorage.getItem('cerp-show-thoughts') === 'true')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const toggleShowThoughts = useCallback(() => {
    setShowThoughts((prev) => {
      const next = !prev
      localStorage.setItem('cerp-show-thoughts', String(next))
      return next
    })
  }, [])

  // Show toast on agent error
  useEffect(() => {
    if (error) addToast('error', error)
  }, [error, addToast])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTool])

  // Expose restoreMessages and clearMessages to parent via refs
  // Wrap to also reset persistence-tracking refs on conversation switch
  useEffect(() => {
    if (restoreMessagesRef) {
      restoreMessagesRef.current = (msgs: ChatMessage[]) => {
        restoreMessages(msgs)
        prevMessageCountRef.current = msgs.length
        wasStreamingRef.current = false
      }
    }
    if (clearMessagesRef) {
      clearMessagesRef.current = () => {
        clearMessages()
        prevMessageCountRef.current = 0
        wasStreamingRef.current = false
      }
    }
  }, [restoreMessages, clearMessages, restoreMessagesRef, clearMessagesRef])

  // Expose current chat state for parent to read before conversation switch
  useEffect(() => {
    if (chatStateRef) {
      chatStateRef.current = { isStreaming, messages, abort }
    }
  })

  // Sync completed messages to backend (fire-and-forget)
  const prevMessageCountRef = useRef(0)
  useEffect(() => {
    if (!onMessageComplete) return
    const count = messages.length
    if (count > prevMessageCountRef.current) {
      const newMessages = messages.slice(prevMessageCountRef.current)
      for (const msg of newMessages) {
        if (msg.role === 'user') {
          onMessageComplete(msg)
        } else if (msg.role === 'assistant' && !isStreaming) {
          onMessageComplete(msg)
        }
      }
    }
    prevMessageCountRef.current = count
  }, [messages, isStreaming, onMessageComplete])

  // When streaming stops, sync the last assistant message
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && onMessageComplete) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg?.role === 'assistant') {
        onMessageComplete(lastMsg)
      }
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming, messages, onMessageComplete])

  // Track agent activity from delegation events
  useEffect(() => {
    if (activeAgentDelegation) {
      onAgentActivity(activeAgentDelegation.agentName, 'active')
    }
    if (isStreaming) {
      onAgentActivity('orchestrator', 'active')
    }
    if (!isStreaming && !activeTool) {
      onAgentActivity('orchestrator', messages.length > 0 ? 'done' : 'idle')
    }
  }, [activeAgentDelegation, isStreaming, activeTool, messages.length, onAgentActivity])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    setInput('')
    sendPrompt(trimmed, cwd || undefined, activeContextId || undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape' && isStreaming) {
      abort()
    }
  }

  // Global Escape key to abort
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isStreaming) {
        abort()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [isStreaming, abort])

  const handleQuickAction = (prompt: string) => {
    // If a working folder is selected, inject it into the prompt so the AI knows where to look
    const fullPrompt = cwd
      ? `${prompt}\n\nMi carpeta de trabajo es: ${cwd}`
      : prompt
    sendPrompt(fullPrompt, cwd || undefined, activeContextId || undefined)
  }

  const handleSelectFolder = async () => {
    const folder = await window.cerpAPI.selectFolder()
    if (folder) setCwd(folder)
  }

  const handleNewConversation = async () => {
    await window.cerpAPI.resetSession()
    clearMessages()
    setCwd(null)
    onNewConversation()
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      const paths = files.map((f) => (f as any).path || f.name)
      const pathsText = paths.join('\n')
      setInput((prev) => (prev ? `${prev}\n${pathsText}` : pathsText))
      inputRef.current?.focus()
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 ${isDragOver ? 'ring-2 ring-brand-orange/50 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Folder indicator */}
      {cwd && (
        <div className="flex items-center gap-3 px-6 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
          <span className="font-mono text-slate-600 truncate">{cwd}</span>
          <button onClick={() => setCwd(null)} className="text-slate-400 hover:text-slate-600">
            &#x2715;
          </button>
        </div>
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-orange/5 border-2 border-dashed border-brand-orange/30 rounded-lg pointer-events-none">
          <span className="text-brand-orange font-medium text-sm">Soltar archivos aqui</span>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 relative">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-8">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                Hola{userName ? ` ${userName.split(' ')[0]}` : ''}, soy CERP AI
              </h2>
              <p className="text-slate-500 text-sm max-w-md">
                Tu asistente para cotizaciones y licitaciones de obra. Arrastra tus archivos o selecciona una carpeta para empezar.
              </p>
            </div>
            <QuickActions onSelect={handleQuickAction} disabled={isStreaming} />
            <p className="text-xs text-slate-400 mt-2">
              Arrastra archivos al chat o selecciona una carpeta de trabajo
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => {
              const isLastAssistant = isStreaming && i === messages.length - 1 && msg.role === 'assistant'
              return (
                <MessageBubble
                  key={i}
                  message={msg}
                  isStreaming={isLastAssistant || undefined}
                  showThoughts={showThoughts}
                  onToggleThoughts={msg.role === 'assistant' && msg.tools?.length ? toggleShowThoughts : undefined}
                  onStop={isLastAssistant ? abort : undefined}
                />
              )
            })}
            {/* Immediate thinking indicator before first assistant message arrives */}
            {isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant') && (
              showThoughts ? (
                <div className="flex items-center gap-2 px-4 py-2 mb-2">
                  <LoadingSpinner size="sm" />
                  <span className="text-xs text-slate-400 animate-pulse">Pensando...</span>
                </div>
              ) : (
                <div className="flex justify-start mb-4">
                  <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-white border border-slate-200 px-4 py-3 shadow-sm">
                    <ThinkingLoader onToggleDetails={toggleShowThoughts} onStop={abort} />
                  </div>
                </div>
              )
            )}
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

      {/* Prompt suggestions */}
      {!isStreaming && promptSuggestions.length > 0 && (
        <div className="px-6 pb-2 flex flex-wrap gap-2">
          {promptSuggestions.map((suggestion, i) => (
            <button
              key={i}
              onClick={() => {
                setInput('')
                sendPrompt(suggestion, cwd || undefined, activeContextId || undefined)
              }}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-full text-slate-600 hover:border-brand-orange/40 hover:text-brand-orange transition-colors truncate max-w-[250px]"
            >
              {suggestion}
            </button>
          ))}
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
              placeholder={
                cwd
                  ? `Pregunta sobre ${cwd.split(/[\\/]/).pop()}...`
                  : 'Pregunta lo que necesites...'
              }
              rows={input.split('\n').length > 3 ? 4 : input.includes('\n') ? 2 : 1}
              className="w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
              disabled={isStreaming}
            />
          </div>

          <button
            type="button"
            onClick={handleSelectFolder}
            className={`p-2.5 rounded-lg border transition-colors ${cwd ? 'border-brand-orange/30 bg-orange-50 text-brand-orange' : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
            title="Seleccionar carpeta de trabajo"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

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

        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-slate-300">
            Arrastra archivos al chat para adjuntar su ruta
          </span>
          {messages.length > 0 && (
            <button
              onClick={handleNewConversation}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              + Nueva conversacion
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
