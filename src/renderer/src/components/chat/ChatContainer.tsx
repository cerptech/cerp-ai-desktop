import { useState, useRef, useEffect, useCallback, DragEvent, MutableRefObject } from 'react'
import { ClipboardCheck, Zap } from 'lucide-react'
import { useAgent, type ChatMessage } from '@/hooks/useAgent'
import { sendPrompt as storeSendPrompt } from '@/stores/agentRuntimeStore'
import { MessageBubble } from './MessageBubble'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { AskUserQuestion } from './AskUserQuestion'
import { QuickActions } from './QuickActions'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ThinkingLoader } from './ThinkingLoader'
import { useToast } from '@/hooks/useToast'
import { usePlanMode } from '@/hooks/usePlanMode'
import { useTurboMode } from '@/hooks/useTurboMode'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDictation, type DictationError } from '@/hooks/useDictation'
import { useAttachments, MAX_ATTACHMENTS, type AttachmentFile } from '@/hooks/useAttachments'
import { useModelChoice } from '@/hooks/useModelChoice'
import { useToolsSetup } from '@/hooks/useToolsSetup'
import { buildConversationTitle } from '@/utils/conversationTitle'
import { formatSessionCost } from '@/utils/formatCost'

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

export function ChatContainer({ userName, activeContextId, activeConversationId, ensureConversation, onNewConversation, searchInputRef, onSessionActiveChange, setCwdRef, setInputRef }: ChatContainerProps) {
  // La hook selecciona el runtime de la conversación activa; las demás siguen
  // corriendo en el store. La persistencia la maneja el store (cubre las de fondo).
  const { messages, isStreaming, isPending, activeTool, promptSuggestions, statusMessage, error, errorCode, pendingQuestions, isSubmittingAnswers, sessionCost, abort, submitAnswers } = useAgent(activeConversationId ?? '__default__')
  const { addToast } = useToast()
  const { planMode, togglePlanMode } = usePlanMode()
  const { turboMode, toggleTurboMode } = useTurboMode()
  const { modelChoice, setModelChoice } = useModelChoice()
  // Ola 3 — Git/Python se preparan en background tras el login; esto gatea solo las
  // quick actions que realmente los necesitan (ver QUICK_ACTIONS.requiresTools).
  const toolsSetup = useToolsSetup()
  const { attachments, addFiles, removeAttachment, clearAttachments } = useAttachments()
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showThoughts, setShowThoughts] = useState(true)
  const [appVersion, setAppVersion] = useState('...')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // cwd en un ref para que doSend (callback estable) lea el valor actual sin recrearse.
  const cwdRef = useRef<string | null>(cwd)
  useEffect(() => { cwdRef.current = cwd }, [cwd])

  // modelChoice en un ref por el mismo motivo que cwd — doSend es un callback estable.
  const modelChoiceRef = useRef(modelChoice)
  useEffect(() => { modelChoiceRef.current = modelChoice }, [modelChoice])

  // Envío con "crear-antes-de-enviar": si no hay conversación activa, la creamos
  // para tener un id real (cada conversación necesita su propia sesión en el main).
  const doSend = useCallback(async (fullPrompt: string, options?: { skipUserEcho?: boolean }): Promise<void> => {
    let id = activeConversationId
    if (!id) id = await ensureConversation(buildConversationTitle(fullPrompt))
    if (!id) return
    storeSendPrompt(id, fullPrompt, cwdRef.current || undefined, activeContextId || undefined, modelChoiceRef.current, options)
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

  // Nota: la persistencia de mensajes (incl. conversaciones de fondo) y la
  // restauración/limpieza de runtimes las maneja agentRuntimeStore — ya no viven
  // acá. Esta vista solo lee el runtime de la conversación activa.

  // Notify parent when the session goes active/idle — drives the header badge.
  useEffect(() => {
    onSessionActiveChange?.(isStreaming || isPending || !!pendingQuestions)
  }, [isStreaming, isPending, pendingQuestions, onSessionActiveChange])

  // Expose folder + input setters so the onboarding wizard can wire step 3
  // (connect folder) and step 4 (inject a pre-armed prompt) to the real chat.
  // El auto-resize del textarea ya no vive acá: lo maneja el propio Composer
  // vía un `useLayoutEffect` sobre `value`, así que alcanza con enfocarlo.
  useEffect(() => {
    if (setCwdRef) setCwdRef.current = (path: string) => setCwd(path)
    if (setInputRef) {
      setInputRef.current = (text: string) => {
        setInput(text)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
  }, [setCwdRef, setInputRef])

  // --- Dictado por voz (Ola 1) ---
  // El texto SIEMPRE se concatena al textarea existente — nunca se envía solo, el
  // usuario tiene que poder revisarlo antes de mandar.
  const handleDictationTranscript = useCallback((text: string) => {
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }, [])

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

  const handleDictate = () => {
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

  const handleSubmit = () => {
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

  // Escape global para abortar (cubre el caso en que el textarea no tiene foco)
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

  const handleClearFolder = () => setCwd(null)

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
  // skipUserEcho: true porque lastUserMessage.content YA está en `messages` (y ya
  // persistido) de la vez anterior — sin esto, doSend agregaba Y persistía un
  // segundo mensaje de usuario idéntico, duplicando la burbuja en el chat y en la DB.
  const handleRegenerate = useCallback(() => {
    if (isStreaming || isPending || pendingQuestions) return
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMessage) return
    addToast('info', 'Reintentando…')
    doSend(lastUserMessage.content, { skipUserEcho: true })
  }, [messages, isStreaming, isPending, pendingQuestions, doSend, addToast])

  const isEmpty = messages.length === 0

  return (
    <div
      className={`relative flex flex-col flex-1 min-w-0 bg-white ${isDragOver ? 'ring-2 ring-brand-orange/50 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Plan Mode banner — shown at the top when active */}
      {planMode && (
        <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700">
          <ClipboardCheck className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="font-medium">Modo plan activo</span>
          <span className="text-amber-500">— el agente planificará sin ejecutar acciones de escritura. Desactívalo para continuar con la ejecución.</span>
        </div>
      )}

      {/* Turbo Mode banner — shown at the top when active (Idea 3) */}
      {turboMode && (
        <div className="flex items-center gap-2 px-6 py-2 bg-violet-50 border-b border-violet-200 text-xs text-violet-700">
          <Zap className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="font-medium">Modo Turbo activo</span>
          <span className="text-violet-500">— esta cotización usa más recursos y tarda más, a cambio de mayor precisión en licitaciones complejas.</span>
        </div>
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-orange/5 border-2 border-dashed border-brand-orange/30 rounded-lg pointer-events-none">
          <span className="text-brand-orange font-medium text-sm">Soltar archivos aquí</span>
        </div>
      )}

      {/* Messages area — autoscroll "stick to bottom" (Ola 2, MessageList) */}
      <MessageList deps={[messages, activeTool, pendingQuestions]} busy={isStreaming} className="px-6">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-8 py-16">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-brand-black mb-2">
                Hola{userName ? ` ${userName.split(' ')[0]}` : ''}, soy CERP AI
              </h2>
              <p className="text-slate-500 text-sm max-w-md">
                Tu asistente para cotizaciones y licitaciones de obra. Arrastra tus archivos o selecciona una carpeta para empezar.
              </p>
            </div>
            <QuickActions onSelect={handleQuickAction} disabled={isStreaming} toolsSetup={toolsSetup} />
            <p className="text-xs text-slate-400 mt-2">
              Arrastra archivos al chat o selecciona una carpeta de trabajo
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-5 py-6">
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
            {/* Typing dots — indicador ÚNICO durante el hueco inicial, antes de que
                exista la burbuja del asistente. Una vez que empieza a streamear texto
                (token a token) o hay tools corriendo, el mensaje mismo lo cubre. */}
            {(isPending || isStreaming) && (() => {
              const lastMsg = messages[messages.length - 1]
              const noAssistantYet = !lastMsg || lastMsg.role !== 'assistant'
              if (!noAssistantYet) return null
              return <ThinkingLoader onToggleDetails={toggleShowThoughts} onStop={abort} />
            })()}
          </div>
        )}
      </MessageList>

      {/* Paywall: la empresa se quedó sin créditos de IA (Modelo CERP) */}
      {error && errorCode === 'NO_CREDITS' && (
        <div className="mx-6 mb-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-2xl text-sm text-red-800 flex items-center justify-between gap-3">
          <span>Tu empresa no tiene créditos de IA — recarga desde Configuración &gt; Suscripción.</span>
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
        <div className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-2xl text-sm text-red-700">
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
            <span className="text-xs font-medium text-slate-500">El agente necesita tu decisión para continuar</span>
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
              className="px-3 py-1.5 text-xs bg-white border border-composer-border rounded-full text-slate-600 hover:border-brand-orange/40 hover:text-brand-orange transition-colors truncate max-w-[250px]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {/* Composer — converge con ai.cerp.es (Ola 2) */}
      <div className="px-6 pb-4 pt-2">
        <div className="mx-auto max-w-[780px]">
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            disabled={isStreaming || !!pendingQuestions}
            placeholder={cwd ? `Pregunta sobre ${cwd.split(/[\\/]/).pop()}…` : 'Pregunta lo que necesites…'}
            streaming={isStreaming}
            onStop={abort}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            attachmentsMaxed={attachments.length >= MAX_ATTACHMENTS}
            onSelectAttachments={handleSelectAttachments}
            dictationStatus={dictation.status}
            onDictate={handleDictate}
            dictationLevel={dictation.level}
            dictationElapsedSeconds={dictation.elapsedSeconds}
            dictationSilence={dictation.silence}
            modelChoice={modelChoice}
            onModelChange={setModelChoice}
            modelSelectorDisabled={turboMode}
            planMode={planMode}
            onTogglePlanMode={togglePlanMode}
            turboMode={turboMode}
            onToggleTurboMode={toggleTurboMode}
            cwd={cwd}
            onSelectFolder={handleSelectFolder}
            onClearFolder={handleClearFolder}
            textareaRef={inputRef}
          />

          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] text-slate-300">v{appVersion}</span>
              {/* Costo de sesión (Ola 3) — discreto, solo si ya se acumuló algo. */}
              {sessionCost > 0 && (
                <span className="text-[11px] text-slate-400" title="Costo estimado de esta conversación">
                  Sesión: {formatSessionCost(sessionCost)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
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
                  + Nueva conversación
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
