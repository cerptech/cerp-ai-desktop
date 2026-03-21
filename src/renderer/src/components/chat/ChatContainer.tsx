import { useState, useRef, useEffect, DragEvent } from 'react'
import { useAgent } from '@/hooks/useAgent'
import { MessageBubble } from './MessageBubble'
import { QuickActions } from './QuickActions'
import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { AGENTS } from '@/components/agents/agentConfig'

interface ChatContainerProps {
  userName?: string
  selectedAgent: string
  onAgentActivity: (agentName: string, status: 'active' | 'done' | 'idle') => void
  onNewConversation: () => void
}

export function ChatContainer({ userName, selectedAgent, onAgentActivity, onNewConversation }: ChatContainerProps) {
  const { messages, isStreaming, activeTool, error, sendPrompt, abort, clearMessages } = useAgent()
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTool])

  // Track agent activity from tool events
  useEffect(() => {
    if (activeTool) {
      // Detect agent delegation
      if (activeTool === 'Agent') {
        const lastMsg = messages[messages.length - 1]
        const lastTool = lastMsg?.tools?.find((t) => t.name === 'Agent' && t.status === 'running')
        if (lastTool?.input) {
          const agentName = AGENTS.find((a) => lastTool.input?.includes(a.name))?.name
          if (agentName) onAgentActivity(agentName, 'active')
        }
      }
      onAgentActivity('orchestrator', 'active')
    }
    if (!isStreaming && !activeTool) {
      onAgentActivity('orchestrator', messages.length > 0 ? 'done' : 'idle')
    }
  }, [activeTool, isStreaming, messages, onAgentActivity])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    setInput('')

    // If a specific agent is selected, prepend instruction
    let prompt = trimmed
    if (selectedAgent !== 'orchestrator') {
      const agent = AGENTS.find((a) => a.name === selectedAgent)
      if (agent) {
        prompt = `[Usa el agente ${agent.name}] ${trimmed}`
      }
    }

    sendPrompt(prompt, cwd || undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleQuickAction = (prompt: string) => {
    sendPrompt(prompt, cwd || undefined)
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
  const currentAgent = AGENTS.find((a) => a.name === selectedAgent)

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 ${isDragOver ? 'ring-2 ring-brand-orange/50 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Folder + agent indicator */}
      {(cwd || selectedAgent !== 'orchestrator') && (
        <div className="flex items-center gap-3 px-6 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
          {selectedAgent !== 'orchestrator' && currentAgent && (
            <div className="flex items-center gap-1.5">
              <span>{currentAgent.icon}</span>
              <span className="font-medium text-brand-orange">{currentAgent.label}</span>
            </div>
          )}
          {cwd && (
            <>
              {selectedAgent !== 'orchestrator' && <span className="text-slate-300">|</span>}
              <span className="font-mono text-slate-600 truncate">{cwd}</span>
              <button onClick={() => setCwd(null)} className="text-slate-400 hover:text-slate-600">
                &#x2715;
              </button>
            </>
          )}
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
                {selectedAgent !== 'orchestrator' && currentAgent
                  ? `${currentAgent.icon} ${currentAgent.label}`
                  : `Hola${userName ? ` ${userName.split(' ')[0]}` : ''}, soy CERP AI`}
              </h2>
              <p className="text-slate-500 text-sm max-w-md">
                {selectedAgent !== 'orchestrator' && currentAgent
                  ? currentAgent.description
                  : 'Tu asistente inteligente con acceso completo a tu ordenador y datos de CERP'}
              </p>
            </div>
            <QuickActions onSelect={handleQuickAction} disabled={isStreaming} />
            <p className="text-xs text-slate-400 mt-2">
              Arrastra archivos al chat o selecciona una carpeta de trabajo
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {isStreaming && !activeTool && messages[messages.length - 1]?.content === '' && (
              <div className="flex items-center gap-2 px-4 py-2 mb-2">
                <LoadingSpinner size="sm" />
                <span className="text-xs text-slate-400 animate-pulse">Pensando...</span>
              </div>
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
                selectedAgent !== 'orchestrator' && currentAgent
                  ? `Pregunta al ${currentAgent.label}...`
                  : cwd
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
