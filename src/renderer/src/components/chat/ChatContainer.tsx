import { useState, useRef, useEffect, useCallback, DragEvent, MutableRefObject } from 'react'
import { Mic, Square, Loader2, Paperclip } from 'lucide-react'
import { useAgent, type ChatMessage } from '@/hooks/useAgent'
import { sendPrompt as storeSendPrompt } from '@/stores/agentRuntimeStore'
import { MessageBubble } from './MessageBubble'
import { AskUserQuestion } from './AskUserQuestion'
import { QuickActions } from './QuickActions'
import { AttachmentCard } from './AttachmentCard'
import { ModelSelector } from './ModelSelector'
import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ThinkingLoader } from './ThinkingLoader'
import { useToast } from '@/hooks/useToast'
import { usePlanMode } from '@/hooks/usePlanMode'
import { useTurboMode } from '@/hooks/useTurboMode'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDictation, type DictationError } from '@/hooks/useDictation'
import { useAttachments, MAX_ATTACHMENTS, type AttachmentFile } from '@/hooks/useAttachments'
import { useModelChoice } from '@/hooks/useModelChoice'

export interface ChatStateSnapshot {
  isStreaming: boolean
  isPending: boolean
  messages: ChatMessage[]
  abort: () => Promise<void>
}

interface ChatContainerProps {
  userName?: string
  activeContextId?: string | null
  /** Conversación activa cuyo runtime se muestra. null = pantalla nueva (aún sin id). */
  activeConversationId?: string | null
  /** Garantiza que exista una conversación para enviar; crea una si no hay activa. */
  ensureConversation: (title: string) => Promise<string | null>
  onAgentActivity: (agentName: string, status: 'active' | 'done' | 'idle') => void
  onNewConversation: () => void
  /** Ref to the sidebar search input — used by Ctrl/Cmd+K to focus it */
  searchInputRef?: MutableRefObject<HTMLInputElement | null>
  /** Notifies the parent when the agent session goes active/idle (for the header badge). */
  onSessionActiveChange?: (active: boolean) => void
  /** Exposes a setter so the onboarding wizard can wire the working folder. */
  setCwdRef?: MutableRefObject<((path: string) => void) | null>
  /** Exposes a setter so the onboarding wizard can inject a pre-armed prompt. */
  setInputRef?: MutableRefObject<((text: string) => void) | null>
}

export function ChatContainer({ userName, activeContextId, activeConversationId, ensureConversation, onAgentActivity, onNewConversation, searchInputRef, onSessionActiveChange, setCwdRef, setInputRef }: ChatContainerProps) {
  // La hook selecciona el runtime de la conversación activa; las demás siguen
  // corriendo en el store. La persistencia la maneja el store (cubre las de fondo).
  const { messages, isStreaming, isPending, activeTool, activeAgentDelegation, promptSuggestions, statusMessage, error, errorCode, pendingQuestions, isSubmittingAnswers, abort, submitAnswers } = useAgent(activeConversationId ?? '__default__')
  const { addToast } = useToast()
  const { planMode, togglePlanMode } = usePlanMode()
  const { turboMode, toggleTurboMode } = useTurboMode()
  const { modelChoice, setModelChoice } = useModelChoice()
  const { attachments, addFiles, removeAttachment, clearAttachments } = useAttachments()
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showThoughts, setShowThoughts] = useState(true)
  const [appVersion, setAppVersion] = useState('...')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // cwd en un ref para que doSend (callback estable) lea el valor actual sin recrearse.
  const cwdRef = useRef<string | null>(cwd)
  useEffect(() => { cwdRef.current = cwd }, [cwd])

  // modelChoice en un ref por el mismo motivo que cwd — doSend es un callback estable.
  const modelChoiceRef = useRef(modelChoice)
  useEffect(() => { modelChoiceRef.current = modelChoice }, [modelChoice])

  // Envío con "crear-antes-de-enviar": si no hay conversación activa, la creamos
  // para tener un id real (cada conversación necesita su propia sesión en el main).
  const doSend = useCallback(async (fullPrompt: string): Promise<void> => {
    let id = activeConversationId
    if (!id) id = await ensureConversation(fullPrompt.slice(0, 50) || 'Nueva conversacion')
    if (!id) return
    storeSendPrompt(id, fullPrompt, cwdRef.current || undefined, activeContextId || undefined, modelChoiceRef.current)
  }, [activeConversationId, ensureConversation, activeContextId])

  useEffect(() => {
    window.cerpAPI.getVersion().then(setAppVersion).catch(() => setAppVersion('1.0.0'))
  }, [])

  const toggleShowThoughts = useCallback(() => {
    setShowThoughts((prev) => !prev)
  }, [])

  // Show toast on agent error — NO_CREDITS gets its own persistent banner below
  // instead of a toast, so it doesn't disappear before the user notices it.
  // AUTH_EXPIRED gets no toast either: the global SessionExpiredModal is already
  // showing (or about to), a red toast on top of it would be redundant noise.
  useEffect(() => {
    if (error && errorCode !== 'NO_CREDITS' && errorCode !== 'AUTH_EXPIRED') addToast('error', error)
  }, [error, errorCode, addToast])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTool, pendingQuestions])

  // Nota: la persistencia de mensajes (incl. conversaciones de fondo) y la
  // restauración/limpieza de runtimes las maneja agentRuntimeStore — ya no viven
  // acá. Esta vista solo lee el runtime de la conversación activa.

  // Notify parent when the session goes active/idle — drives the header badge.
  useEffect(() => {
    onSessionActiveChange?.(isStreaming || isPending || !!pendingQuestions)
  }, [isStreaming, isPending, pendingQuestions, onSessionActiveChange])

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

  // --- Textarea autoresize ---
  // Technique: set height to 'auto' first so shrinkage works, then to scrollHeight.
  // Max height is capped at ~8 lines via CSS max-height on the textarea.
  const adjustTextareaHeight = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  // Reset height when input is programmatically cleared (e.g. after submit)
  useEffect(() => {
    if (input === '' && inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
  }, [input])

  // Expose folder + input setters so the onboarding wizard can wire step 3
  // (connect folder) and step 4 (inject a pre-armed prompt) to the real chat.
  useEffect(() => {
    if (setCwdRef) setCwdRef.current = (path: string) => setCwd(path)
    if (setInputRef) {
      setInputRef.current = (text: string) => {
        setInput(text)
        // Defer so the textarea has the new value before we resize/focus it.
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (el) {
            adjustTextareaHeight(el)
            el.focus()
          }
        })
      }
    }
  }, [setCwdRef, setInputRef, adjustTextareaHeight])

  // --- Dictado por voz (Ola 1) ---
  // El texto SIEMPRE se concatena al textarea existente — nunca se envía solo, el
  // usuario tiene que poder revisarlo antes de mandar.
  const handleDictationTranscript = useCallback((text: string) => {
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
    // Defer so the textarea has the new value before we resize/focus it (mismo
    // patrón que setInputRef más abajo).
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        adjustTextareaHeight(el)
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }, [adjustTextareaHeight])

  const handleDictationError = useCallback((kind: DictationError) => {
    const messages: Record<DictationError, string> = {
      permission: 'No pudimos acceder al micrófono. Revisa los permisos de la aplicación en tu sistema.',
      unsupported: 'Tu sistema no soporta grabación de audio.',
      // El modal global de sesión expirada (Ola 0) ya se dispara solo — este toast es
      // un refuerzo breve, no la única señal.
      session: 'Tu sesión expiró. Inicia sesión de nuevo.',
      failed: 'No se pudo transcribir el audio. Intenta de nuevo.',
    }
    addToast('error', messages[kind])
  }, [addToast])

  const dictation = useDictation({ onTranscript: handleDictationTranscript, onError: handleDictationError })

  const handleMicClick = () => {
    if (dictation.status === 'recording') {
      dictation.stop()
    } else if (dictation.status === 'idle') {
      dictation.start()
    }
  }

  // --- Adjuntos multi-archivo (Ola 1) ---
  const handleSelectAttachments = async () => {
    const files = await window.cerpAPI.selectAttachments()
    if (files.length) addFiles(files)
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = input.trim()
    if ((!trimmed && attachments.length === 0) || isStreaming || pendingQuestions) return

    // Bloque estable, una línea por archivo — el agente los lee del disco, igual que
    // antes con el PDF único (mismo formato `[Archivo adjunto: ...]`).
    const attachmentsBlock = attachments.length
      ? '\n\n' + attachments.map((a) => `[Archivo adjunto: ${a.path}]`).join('\n')
      : ''
    const fullPrompt = `${trimmed}${attachmentsBlock}`.trim()

    setInput('')
    clearAttachments()
    doSend(fullPrompt)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
      return
    }
    if (e.key === 'Escape') {
      if (isStreaming) {
        abort()
      } else if (input.trim()) {
        setInput('')
      }
      return
    }
  }

  // Global Escape key to abort (covers cases where textarea is not focused)
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
    doSend(fullPrompt)
  }

  const handleSelectFolder = async () => {
    const folder = await window.cerpAPI.selectFolder()
    if (folder) setCwd(folder)
  }

  // "Nueva conversación" ya NO resetea ninguna sesión: las demás conversaciones
  // siguen corriendo en el store. Solo limpia la vista (el padre pone active=null,
  // que muestra una pantalla nueva vacía).
  const handleNewConversation = useCallback(() => {
    setCwd(null)
    onNewConversation()
  }, [onNewConversation])

  // --- Global keyboard shortcuts (Ctrl/Cmd+N, Ctrl/Cmd+K) ---
  // Must come after handleNewConversation so the stable callback reference is ready.
  useKeyboardShortcuts({
    onNewConversation: handleNewConversation,
    searchInputRef,
    chatInputRef: inputRef,
  })

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

  // Archivos soltados se convierten en tarjetas de adjunto — ya NO se pegan como
  // texto de ruta en el textarea (Ola 1). webUtils.getPathForFile es el reemplazo
  // oficial de File.path (removido en Electron 32+ por seguridad).
  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const mapped: AttachmentFile[] = []
    for (const file of files) {
      try {
        const path = window.cerpAPI.getPathForFile(file)
        if (!path) continue
        const ext = (file.name.split('.').pop() || '').toLowerCase()
        mapped.push({ path, name: file.name, ext, sizeBytes: file.size })
      } catch {
        // Archivo sin path resoluble (p.ej. arrastrado desde otro origen no-FS) — se ignora.
      }
    }
    if (mapped.length) addFiles(mapped)
  }

  // Regenerar (Ola 1) — reenvía el ÚLTIMO prompt del usuario por el flujo normal
  // (doSend), en la MISMA conversación/sesión del SDK (no crea ni reinicia sesión).
  const handleRegenerate = useCallback(() => {
    if (isStreaming || isPending || pendingQuestions) return
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMessage) return
    addToast('info', 'Reintentando…')
    doSend(lastUserMessage.content)
  }, [messages, isStreaming, isPending, pendingQuestions, doSend, addToast])

  const isEmpty = messages.length === 0

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 ${isDragOver ? 'ring-2 ring-brand-orange/50 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Plan Mode banner — shown at the top when active */}
      {planMode && (
        <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span className="font-medium">Modo plan activo</span>
          <span className="text-amber-500">— el agente planificara sin ejecutar acciones de escritura. Desactivalo para continuar con la ejecucion.</span>
        </div>
      )}

      {/* Turbo Mode banner — shown at the top when active (Idea 3) */}
      {turboMode && (
        <div className="flex items-center gap-2 px-6 py-2 bg-violet-50 border-b border-violet-200 text-xs text-violet-700">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <span className="font-medium">Modo Turbo activo</span>
          <span className="text-violet-500">— esta cotización usa más recursos y tarda más, a cambio de mayor precisión en licitaciones complejas.</span>
        </div>
      )}

      {/* Folder indicator */}
      {cwd && (
        <div className="flex items-center gap-3 px-6 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
          <span className="font-mono text-slate-600 truncate">{cwd}</span>
          <button onClick={() => setCwd(null)} className="text-slate-400 hover:text-slate-600">
            &#x2715;
          </button>
        </div>
      )}

      {/* Adjuntos (Ola 1) — tarjetas por archivo, arriba de la barra de input */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-6 py-2 bg-orange-50/60 border-b border-orange-100">
          {attachments.map((a) => (
            <AttachmentCard key={a.path} attachment={a} onRemove={removeAttachment} />
          ))}
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
              const isLastMessage = i === messages.length - 1
              const isLastAssistant = isStreaming && isLastMessage && msg.role === 'assistant'
              // Regenerar solo tiene sentido sobre el último mensaje del asistente, y
              // solo cuando su turno ya terminó (no mientras está streameando).
              const canRegenerate = isLastMessage && msg.role === 'assistant' && !isLastAssistant
              return (
                <MessageBubble
                  key={i}
                  message={msg}
                  isStreaming={isLastAssistant || undefined}
                  showThoughts={showThoughts}
                  onToggleThoughts={msg.role === 'assistant' && msg.tools?.length ? toggleShowThoughts : undefined}
                  onStop={isLastAssistant ? abort : undefined}
                  onRegenerate={canRegenerate ? handleRegenerate : undefined}
                  regenerateDisabled={isStreaming || isPending || !!pendingQuestions}
                />
              )
            })}
            {/* Standalone "Trabajando..." loader — shown ONLY during the initial gap, before
                the assistant bubble exists. Once the assistant message is rendering, its own
                inline indicator (tools "trabajando..." / blinking cursor) covers the state, so
                we never show a second redundant bubble. */}
            {(isPending || isStreaming) && (() => {
              const lastMsg = messages[messages.length - 1]
              const noAssistantYet = !lastMsg || lastMsg.role !== 'assistant'
              if (!noAssistantYet) return null
              return (
                <div className="flex justify-start mb-4">
                  <div className="rounded-2xl rounded-bl-md bg-white border border-slate-200 px-4 py-2 shadow-sm">
                    <ThinkingLoader onToggleDetails={toggleShowThoughts} onStop={abort} />
                  </div>
                </div>
              )
            })()}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Paywall: la empresa se quedó sin créditos de IA (Modelo CERP) */}
      {error && errorCode === 'NO_CREDITS' && (
        <div className="mx-6 mb-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between gap-3">
          <span>Tu empresa no tiene créditos de IA — recargá desde Configuración &gt; Suscripción.</span>
          <a
            href="https://app.cerp.es/settings/subscription"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 font-medium text-red-700 hover:text-red-900 underline transition-colors"
          >
            Recargar
          </a>
        </div>
      )}

      {/* Error display — AUTH_EXPIRED se omite: el SessionExpiredModal global ya cubre ese caso */}
      {error && errorCode !== 'NO_CREDITS' && errorCode !== 'AUTH_EXPIRED' && (
        <div className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Status message discreto (p.ej. "Reconectando con el servidor...") — sobre el input */}
      {statusMessage && (isStreaming || isPending) && (
        <div className="px-6 pb-1.5 flex items-center gap-1.5 text-xs text-slate-400">
          <LoadingSpinner size="sm" />
          <span>{statusMessage}</span>
        </div>
      )}

      {/* Structured question widget — shown when agent invokes ask_user_question tool */}
      {pendingQuestions && pendingQuestions.length > 0 && (
        <div className="mx-6 mb-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse" />
            <span className="text-xs font-medium text-slate-500">El agente necesita tu decision para continuar</span>
          </div>
          <AskUserQuestion
            questions={pendingQuestions}
            onAnswer={submitAnswers}
            isSubmitting={isSubmittingAnswers}
          />
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
                doSend(suggestion)
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
              onChange={(e) => {
                setInput(e.target.value)
                adjustTextareaHeight(e.target)
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                cwd
                  ? `Pregunta sobre ${cwd.split(/[\\/]/).pop()}...`
                  : 'Pregunta lo que necesites...'
              }
              rows={1}
              style={{ maxHeight: '192px', overflowY: 'auto', minHeight: '44px' }}
              className="w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50 disabled:bg-slate-50 disabled:text-slate-400"
              disabled={isStreaming || !!pendingQuestions}
            />
          </div>

          <button
            type="button"
            onClick={handleSelectAttachments}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            className={`h-11 w-11 inline-flex items-center justify-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${attachments.length > 0 ? 'border-brand-orange/30 bg-orange-50 text-brand-orange' : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
            title={attachments.length > 0 ? `${attachments.length} archivo${attachments.length > 1 ? 's' : ''} adjunto${attachments.length > 1 ? 's' : ''}` : 'Adjuntar archivos'}
          >
            <Paperclip className="size-[18px]" strokeWidth={2} aria-hidden="true" />
          </button>

          {/* Dictado por voz (Ola 1) — recording: rojo pulsante (click = parar);
              transcribiendo: spinner; idle: micrófono. El texto SIEMPRE se revisa
              en el textarea antes de mandar, nunca se envía solo. */}
          <button
            type="button"
            onClick={handleMicClick}
            disabled={dictation.status === 'transcribing' || isStreaming || !!pendingQuestions}
            aria-pressed={dictation.status === 'recording'}
            className={`h-11 w-11 inline-flex items-center justify-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              dictation.status === 'recording'
                ? 'border-red-500 bg-red-500 text-white animate-pulse hover:bg-red-600'
                : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'
            }`}
            title={
              dictation.status === 'recording'
                ? 'Detener grabación'
                : dictation.status === 'transcribing'
                  ? 'Transcribiendo...'
                  : 'Dictar por voz'
            }
          >
            {dictation.status === 'transcribing' ? (
              <Loader2 className="size-[18px] animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : dictation.status === 'recording' ? (
              <Square className="size-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
            ) : (
              <Mic className="size-[18px]" strokeWidth={2} aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={handleSelectFolder}
            className={`h-11 w-11 inline-flex items-center justify-center rounded-lg border transition-colors ${cwd ? 'border-brand-orange/30 bg-orange-50 text-brand-orange' : 'border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
            title="Seleccionar carpeta de trabajo"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {/* Selector de modelo (Ola 1) — Turbo Mode tiene prioridad y lo deshabilita visualmente */}
          <ModelSelector value={modelChoice} onChange={setModelChoice} disabled={turboMode} />

          {/* Plan Mode toggle — pill button con texto + icono, visible en ambos estados */}
          <button
            type="button"
            onClick={togglePlanMode}
            aria-pressed={planMode}
            className={`h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border text-sm font-medium transition-all ${
              planMode
                ? 'border-amber-500 bg-amber-100 text-amber-800 ring-2 ring-amber-300 shadow-sm'
                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
            }`}
            title={
              planMode
                ? 'Modo plan ACTIVO — el agente solo planifica, no ejecuta. Click para desactivar.'
                : 'Activar Modo plan — el agente planifica con solo lectura antes de ejecutar acciones.'
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span>Modo plan{planMode ? ' · ON' : ''}</span>
          </button>

          {/* Turbo Mode toggle — cotización exhaustiva (Idea 3) */}
          <button
            type="button"
            onClick={toggleTurboMode}
            aria-pressed={turboMode}
            className={`h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border text-sm font-medium transition-all ${
              turboMode
                ? 'border-violet-500 bg-violet-100 text-violet-800 ring-2 ring-violet-300 shadow-sm'
                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
            }`}
            title={
              turboMode
                ? 'Modo Turbo ACTIVO — máxima precisión para cotizaciones complejas. Usa más recursos y tarda más. Click para desactivar.'
                : 'Activar Modo Turbo — para licitaciones grandes: el agente planifica el presupuesto completo con mayor rigor. Usa más recursos y tarda más, a cambio de mayor precisión.'
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span>Turbo{turboMode ? ' · ON' : ''}</span>
          </button>

          {isStreaming ? (
            <button
              onClick={abort}
              type="button"
              className="h-11 w-11 inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-500 hover:bg-red-100 hover:text-red-600 transition-colors"
              title="Detener ejecucion (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <Button type="submit" disabled={!input.trim() && attachments.length === 0} className="h-11">
              Enviar
            </Button>
          )}
        </form>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-slate-300">v{appVersion}</span>
          <div className="flex items-center gap-3">
            {planMode && (
              <span className="text-xs font-medium text-amber-600 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Modo plan
              </span>
            )}
            {messages.length > 0 && (
              <button
                onClick={toggleShowThoughts}
                className={`text-xs transition-colors ${showThoughts ? 'text-brand-orange' : 'text-slate-400 hover:text-slate-600'}`}
                title={showThoughts ? 'Ocultar ejecuciones' : 'Mostrar ejecuciones'}
              >
                {showThoughts ? 'Ocultar ejecuciones' : 'Ver ejecuciones'}
              </button>
            )}
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
    </div>
  )
}
