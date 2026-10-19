import { useState, useRef, useEffect, useCallback, DragEvent, MutableRefObject } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { useAgent, type ChatMessage } from '@/hooks/useAgent'
import { sendPrompt as storeSendPrompt, setConversationCwd, getRuntime } from '@/stores/agentRuntimeStore'
import { MessageBubble } from './MessageBubble'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { AskUserQuestion } from './AskUserQuestion'
import { PromptLibrary } from './PromptLibrary'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ThinkingLoader } from './ThinkingLoader'
import { useToast } from '@/hooks/useToast'
import { usePlanMode } from '@/hooks/usePlanMode'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDictation, type DictationError } from '@/hooks/useDictation'
import { useAttachments, MAX_ATTACHMENTS, type AttachmentFile } from '@/hooks/useAttachments'
import { useModelChoice } from '@/hooks/useModelChoice'
import { useToolsSetup } from '@/hooks/useToolsSetup'
import { usePromptLibrary } from '@/hooks/usePromptLibrary'
import { findFirstField, type PromptLibraryFamily, type PromptLibraryPrompt } from '@/lib/promptLibrary'
import { buildConversationTitle } from '@/utils/conversationTitle'
import { dataRetryPrompt, withAttachments } from '@/utils/retryPrompt'
import { QuoteFirewallBanner } from '@/components/layout/QuoteFirewallBanner'
import { dismissQuoteFirewall } from '@/hooks/useQuoteFirewall'

export interface ChatStateSnapshot {
  isStreaming: boolean
  isPending: boolean
  messages: ChatMessage[]
  abort: () => Promise<void>
}

/** Aviso de versión mínima (código `DESKTOP_UPDATE_REQUIRED`), el mismo texto que arma el main. */
const DESKTOP_UPDATE_REQUIRED_TEXT = 'Actualiza CERP IA Desktop a la última versión para seguir usándolo.'

interface ChatContainerProps {
  userName?: string
  activeContextId?: string | null
  /** Conversación activa cuyo runtime se muestra. null = pantalla nueva (aún sin id). */
  activeConversationId?: string | null
  /** Garantiza que exista una conversación para enviar; crea una si no hay activa.
   *  `cwd` siembra metadata.cwd en el create (agrupación del sidebar). */
  ensureConversation: (title: string, cwd?: string | null) => Promise<string | null>
  onNewConversation: () => void
  /** Ref to the sidebar search input — used by Ctrl/Cmd+K to focus it */
  searchInputRef?: MutableRefObject<HTMLInputElement | null>
  /** Notifies the parent when the agent session goes active/idle (for the header badge). */
  onSessionActiveChange?: (active: boolean) => void
  /** Exposes a setter so the onboarding wizard can wire the working folder. */
  setCwdRef?: MutableRefObject<((path: string) => void) | null>
  /** Exposes a setter so the onboarding wizard can inject a pre-armed prompt. */
  setInputRef?: MutableRefObject<((text: string) => void) | null>
  /** Informa la carpeta de la conversación visible (bloque «Carpeta» de la barra lateral). */
  onCwdChange?: (cwd: string | null) => void
}

/** Primer nombre con mayúscula inicial: la cuenta puede venir toda en minúsculas. */
function firstNameOf(userName?: string): string {
  const first = userName?.trim().split(/\s+/)[0] ?? ''
  return first ? first[0].toLocaleUpperCase('es-ES') + first.slice(1) : ''
}

/** «VIERNES 16 OCT»: la fecha del día para el saludo del inicio. */
function todayLabel(date = new Date()): string {
  const weekday = date.toLocaleDateString('es-ES', { weekday: 'long' })
  const month = date.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '')
  return `${weekday} ${date.getDate()} ${month}`.toUpperCase()
}

export function ChatContainer({ userName, activeContextId, activeConversationId, ensureConversation, onNewConversation, searchInputRef, onSessionActiveChange, setCwdRef, setInputRef, onCwdChange }: ChatContainerProps) {
  // La hook selecciona el runtime de la conversación activa; las demás siguen
  // corriendo en el store. La persistencia la maneja el store (cubre las de fondo).
  const runtimeId = activeConversationId ?? '__default__'
  const firstName = firstNameOf(userName)
  const { messages, isStreaming, isPending, activeTool, promptSuggestions, statusMessage, error, errorCode, retryPrompt, pendingQuestions, isSubmittingAnswers, abort, submitAnswers, cwd: runtimeCwd } = useAgent(runtimeId)
  const { addToast } = useToast()
  const { planMode, togglePlanMode } = usePlanMode()
  const { modelChoice, setModelChoice } = useModelChoice()
  // Ola 3 — Git/Python se preparan en background tras el login; esto gatea solo las
  // prompts de la biblioteca que realmente los necesitan (`requiresTools`).
  const toolsSetup = useToolsSetup()
  const promptLibrary = usePromptLibrary()
  const { attachments, addFiles, removeAttachment, clearAttachments } = useAttachments()
  const [input, setInput] = useState('')
  // La carpeta de trabajo REAL vive en el runtime de cada conversación (store) —
  // antes era un estado único acá y la última carpeta elegida se aplicaba a todas
  // las conversaciones. `draftCwd` cubre solo la pantalla nueva (sin id todavía):
  // al crear la conversación en doSend, el draft se transfiere a su runtime.
  const [draftCwd, setDraftCwd] = useState<string | null>(null)
  const cwd = activeConversationId ? runtimeCwd : draftCwd
  const [isDragOver, setIsDragOver] = useState(false)
  const [showThoughts, setShowThoughts] = useState(true)
  const [appVersion, setAppVersion] = useState('...')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Prompt de la biblioteca cargado en el composer (F1c). Mientras esté, el envío
  // agrega la carpeta de trabajo al texto, igual que hacían las quick actions al
  // enviar directo. Se descarta si el usuario vacía el composer.
  const libraryPromptRef = useRef<{ id: string; family: string } | null>(null)
  useEffect(() => { if (!input.trim()) libraryPromptRef.current = null }, [input])

  // Enfoca el composer y selecciona el primer [campo] (o deja el cursor al final).
  // Doble rAF: el textarea se re-renderiza y ajusta su alto tras setInput.
  const focusFirstField = useCallback((text: string) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const range = findFirstField(text)
      if (range) el.setSelectionRange(range.start, range.end)
      else el.setSelectionRange(el.value.length, el.value.length)
    }))
  }, [])

  // draftCwd en un ref para que doSend (callback estable) lea el valor actual sin recrearse.
  const draftCwdRef = useRef<string | null>(draftCwd)
  useEffect(() => { draftCwdRef.current = draftCwd }, [draftCwd])

  // modelChoice en un ref por el mismo motivo que cwd — doSend es un callback estable.
  const modelChoiceRef = useRef(modelChoice)
  useEffect(() => { modelChoiceRef.current = modelChoice }, [modelChoice])

  // Envío con "crear-antes-de-enviar": si no hay conversación activa, la creamos
  // para tener un id real (cada conversación necesita su propia sesión en el main).
  const doSend = useCallback(async (fullPrompt: string, options?: { skipUserEcho?: boolean }): Promise<void> => {
    let id = activeConversationId
    let cwdToUse: string | null
    if (id) {
      // Conversación existente: SU carpeta, no la última elegida en otra.
      cwdToUse = getRuntime(id).cwd
    } else {
      // La carpeta del borrador se lee ANTES del await: si el usuario la cambia
      // durante el round-trip del create, el próximo mensaje ya usará la nueva.
      const draft = draftCwdRef.current
      id = await ensureConversation(buildConversationTitle(fullPrompt), draft)
      if (!id) return
      // La carpeta elegida en la pantalla nueva pasa a ser de esta conversación.
      cwdToUse = draft
      if (cwdToUse) setConversationCwd(id, cwdToUse)
      setDraftCwd(null)
    }
    storeSendPrompt(id, fullPrompt, cwdToUse || undefined, activeContextId || undefined, modelChoiceRef.current, options)
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
  // NO_ACTIVE_COMPANY tampoco: el main ya cerró la sesión y App muestra su aviso.
  // COMPANY_CHANGED tampoco: App ya muestra el aviso del cambio de empresa; el banner
  // de abajo queda para recordar que el mensaje no se envió.
  // Un turno cortado con Reintentar (RQM-166) tampoco: su caja de error persistente ya
  // lo dice con el botón, y el toast repetía el mismo texto largo.
  // DESKTOP_UPDATE_REQUIRED tampoco: tiene su aviso persistente abajo.
  useEffect(() => {
    if (retryPrompt) return
    if (
      error &&
      errorCode !== 'NO_CREDITS' &&
      errorCode !== 'AUTH_EXPIRED' &&
      errorCode !== 'NO_ACTIVE_COMPANY' &&
      errorCode !== 'COMPANY_CHANGED' &&
      errorCode !== 'DESKTOP_UPDATE_REQUIRED'
    ) {
      addToast('error', error)
    }
  }, [error, errorCode, retryPrompt, addToast])

  // Nota: la persistencia de mensajes (incl. conversaciones de fondo) y la
  // restauración/limpieza de runtimes las maneja agentRuntimeStore — ya no viven
  // acá. Esta vista solo lee el runtime de la conversación activa.

  useEffect(() => {
    onCwdChange?.(cwd ?? null)
  }, [cwd, onCwdChange])

  // Notify parent when the session goes active/idle — drives the header badge.
  useEffect(() => {
    onSessionActiveChange?.(isStreaming || isPending || !!pendingQuestions)
  }, [isStreaming, isPending, pendingQuestions, onSessionActiveChange])

  // Expose folder + input setters so the onboarding wizard can wire step 3
  // (connect folder) and step 4 (inject a pre-armed prompt) to the real chat.
  // El auto-resize del textarea ya no vive acá: lo maneja el propio Composer
  // vía un `useLayoutEffect` sobre `value`, así que alcanza con enfocarlo.
  useEffect(() => {
    if (setCwdRef) {
      setCwdRef.current = (path: string) => {
        if (activeConversationId) setConversationCwd(activeConversationId, path)
        else setDraftCwd(path)
      }
    }
    if (setInputRef) {
      setInputRef.current = (text: string) => {
        setInput(text)
        focusFirstField(text)
      }
    }
  }, [setCwdRef, setInputRef, activeConversationId, focusFirstField])

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
    // Prompt de la biblioteca: misma inyección de carpeta que hacía handleQuickAction.
    const cwdLine = libraryPromptRef.current && cwd ? `\n\nMi carpeta de trabajo es: ${cwd}` : ''
    const fullPrompt = `${trimmed}${cwdLine}${attachmentsBlock}`.trim()

    libraryPromptRef.current = null
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

  // Biblioteca de prompts (F1c): ya NO envía directo. Carga el prompt en el
  // composer con el primer [campo] seleccionado para que el usuario lo complete;
  // la carpeta de trabajo se agrega al enviar (handleSubmit).
  const handleSelectLibraryPrompt = (prompt: PromptLibraryPrompt, family: PromptLibraryFamily) => {
    setInput(prompt.prompt)
    libraryPromptRef.current = { id: prompt.id, family: family.id }
    focusFirstField(prompt.prompt)
    if (prompt.attachment === 'required' && !cwd && attachments.length === 0) {
      addToast('info', 'Este prompt trabaja con archivos: selecciona tu carpeta de trabajo o adjúntalos antes de enviar.')
    }
  }

  const handleSelectFolder = async () => {
    const folder = await window.cerpAPI.selectFolder()
    if (!folder) return
    if (activeConversationId) setConversationCwd(activeConversationId, folder)
    else setDraftCwd(folder)
  }

  const handleClearFolder = () => {
    if (activeConversationId) setConversationCwd(activeConversationId, null)
    else setDraftCwd(null)
  }

  // "Nueva conversación" ya NO resetea ninguna sesión: las demás conversaciones
  // siguen corriendo en el store. Solo limpia la vista (el padre pone active=null,
  // que muestra una pantalla nueva vacía).
  const handleNewConversation = useCallback(() => {
    setDraftCwd(null)
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

  // Si la ejecución que hizo la pregunta ya terminó (o se cortó), nadie la espera en el
  // main: la respuesta se manda como mensaje normal para que el agente la reciba igual.
  const handleAnswer = useCallback(async (answers: Parameters<typeof submitAnswers>[0]) => {
    const { delivered, fallbackPrompt } = await submitAnswers(answers)
    if (!delivered) doSend(fallbackPrompt, { skipUserEcho: true })
  }, [submitAnswers, doSend])

  // Reintentar una ejecución cortada (RQM-166): manda el prompt que retoma la carga donde
  // quedó, con las rutas de los archivos ya adjuntados en la conversación (no hay que
  // volver a cargarlos). El banner de la carga se limpia: el reintento abre una nueva.
  const sendRetry = useCallback((prompt: string) => {
    if (isStreaming || isPending || pendingQuestions) return
    dismissQuoteFirewall(runtimeId)
    doSend(withAttachments(prompt, messages))
  }, [isStreaming, isPending, pendingQuestions, runtimeId, doSend, messages])

  const handleRetry = retryPrompt ? () => sendRetry(retryPrompt) : undefined
  const handleRetryData = useCallback((failures: string[]) => sendRetry(dataRetryPrompt(failures)), [sendRetry])

  const isEmpty = messages.length === 0

  // Un solo Composer (mismas funciones siempre): en el inicio va grande bajo el
  // saludo («escribir primero»); dentro de una conversación, abajo como siempre.
  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      disabled={isStreaming || !!pendingQuestions}
      placeholder={
        cwd
          ? `Pregunta sobre ${cwd.split(/[\\/]/).pop()}…`
          : isEmpty
            ? 'Por ejemplo: «Cotiza la reforma de una cocina de 12 m² con los planos de mi carpeta»'
            : 'Pregunta lo que necesites o arrastra tus archivos…'
      }
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
      planMode={planMode}
      onTogglePlanMode={togglePlanMode}
      cwd={cwd}
      onSelectFolder={handleSelectFolder}
      onClearFolder={handleClearFolder}
      textareaRef={inputRef}
      size={isEmpty ? 'hero' : 'default'}
    />
  )

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

      {/* Estado de la carga del presupuesto (cortafuegos de cotización) de ESTA conversación */}
      <QuoteFirewallBanner
        conversationId={runtimeId}
        busy={isStreaming || isPending}
        activeTool={activeTool}
        onRetry={handleRetry}
        onRetryData={handleRetryData}
      />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-orange/5 border-2 border-dashed border-brand-orange/30 rounded-lg pointer-events-none">
          <span className="text-brand-orange font-medium text-sm">Soltar archivos aquí</span>
        </div>
      )}

      {/* Messages area — autoscroll "stick to bottom" (Ola 2, MessageList) */}
      <MessageList deps={[messages, activeTool, pendingQuestions]} busy={isStreaming} className="px-6">
        {isEmpty ? (
          // Centrado vertical con `my-auto` (no `justify-center`): si el contenido no
          // entra, el margen cae a 0 y no desborda por arriba (ver el arreglo de la
          // biblioteca cortada). Horizontal: centrado en el área del chat, con la
          // barra lateral abierta u oculta.
          <div className="flex min-h-full flex-col">
            <div className="mx-auto my-auto flex w-full max-w-[720px] flex-col gap-4 py-6 [@media(max-height:680px)]:gap-3 [@media(max-height:680px)]:py-3">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="text-[11px] font-semibold tracking-[0.1em] text-primary-700">{todayLabel()}</p>
                <h2 className="text-[30px] font-bold leading-[38px] tracking-[-0.01em] text-brand-black">
                  Hola{firstName ? `, ${firstName}` : ''}. ¿Qué cotizamos hoy?
                </h2>
                <p className="text-sm leading-[22px] text-brand-gray-dark">
                  Cuéntale a CERP AI qué necesitas o arrastra tus pliegos, planos o presupuestos.
                </p>
              </div>
              {composer}
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-sidebar-border" />
                <span className="text-[11px] font-semibold tracking-[0.08em] text-slate-500">O EMPIEZA CON UNA TAREA</span>
                <span className="h-px flex-1 bg-sidebar-border" />
              </div>
              <PromptLibrary families={promptLibrary.families} onSelect={handleSelectLibraryPrompt} disabled={isStreaming} toolsSetup={toolsSetup} />
            </div>
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

      {/* Versión mínima (F0.2 (b)): el core ya no entrega la config a esta versión. El
          texto sale del código, no del servidor. Donde hay auto-update, el main ya pidió
          el chequeo y el aviso "Reiniciar para actualizar" aparece al terminar la descarga. */}
      {error && errorCode === 'DESKTOP_UPDATE_REQUIRED' && (
        <div role="alert" className="mx-6 mb-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-800">
          {DESKTOP_UPDATE_REQUIRED_TEXT}
        </div>
      )}

      {/* Error display — AUTH_EXPIRED se omite: el SessionExpiredModal global ya cubre ese caso */}
      {error && errorCode !== 'NO_CREDITS' && errorCode !== 'AUTH_EXPIRED' && errorCode !== 'NO_ACTIVE_COMPANY' && errorCode !== 'DESKTOP_UPDATE_REQUIRED' && (
        <div role="alert" className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-2xl text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{error}</span>
          {/* Un turno cortado por un fallo (watchdog, límite de la ejecución, error del
              proceso) se puede retomar donde quedó sin volver a adjuntar nada. */}
          {handleRetry && !isStreaming && !isPending && !pendingQuestions && (
            <button
              onClick={handleRetry}
              className="shrink-0 font-medium text-red-700 hover:text-red-900 underline transition-colors"
            >
              Reintentar
            </button>
          )}
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
            // Un juego de preguntas nuevo remonta el widget: sin key conservaba el paso y
            // las respuestas del anterior.
            key={pendingQuestions.map((q) => q.question).join('|')}
            questions={pendingQuestions}
            onAnswer={handleAnswer}
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

      {/* Composer — converge con ai.cerp.es (Ola 2). En el inicio vive arriba (ver `composer`). */}
      <div className={`px-6 ${isEmpty ? 'pb-3 pt-1' : 'pb-4 pt-2'}`}>
        <div className="mx-auto max-w-[780px]">
          {!isEmpty && composer}

          {/* Pie: versión + aviso, centrado. «Nueva conversación» vive en la barra
              lateral; acá solo queda el interruptor de ejecuciones dentro de un chat. */}
          <div className={`relative flex items-center justify-center ${isEmpty ? '' : 'mt-2'}`}>
            <span className="text-[11px] text-slate-500">v{appVersion} · Revisa siempre las cifras antes de enviar una cotización</span>
            {messages.length > 0 && (
              <button
                onClick={toggleShowThoughts}
                className={`absolute right-0 text-xs transition-colors ${showThoughts ? 'text-brand-orange' : 'text-slate-400 hover:text-slate-600'}`}
                title={showThoughts ? 'Ocultar ejecuciones' : 'Mostrar ejecuciones'}
              >
                {showThoughts ? 'Ocultar ejecuciones' : 'Ver ejecuciones'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
