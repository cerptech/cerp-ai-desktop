import { useState, useEffect, useCallback, useRef } from 'react'
import type { ConversationSummary, ConversationFull, ApiErrorCode } from '../../../preload/index'
import type { ChatMessage } from './useAgent'
import { useToast } from './useToast'

/**
 * El backend guarda `status` como string libre. Al RESTAURAR una conversación de
 * la DB, 'running' nunca es un estado válido — no puede haber una tool corriendo en
 * un turno que ya terminó (persistió). Puede quedar así si el usuario abortó a mitad
 * de una tool call: el `abort()` del store no siempre alcanza a marcarla 'done'/'error'
 * antes de persistir. Mapeamos 'running' → 'done' acá para que no quede una tool
 * congelada en spinner infinito al reabrir la conversación; 'error' SÍ se preserva
 * (una tool que falló de verdad no debe mostrarse como exitosa).
 */
function normalizeToolStatus(status: unknown): 'running' | 'done' | 'error' {
  return status === 'error' ? status : 'done'
}

/** Tope defensivo de lienzos HTML persistidos por mensaje (ver appendMessage). */
const MAX_HTML_CANVASES_PER_MESSAGE = 5

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 'network' → mostrar estado de error con reintento en el panel (no fingir
  // lista vacía). 'auth' → el modal global de sesión expirada ya se está
  // mostrando, no duplicar el aviso acá.
  const [conversationsError, setConversationsError] = useState<ApiErrorCode | null>(null)
  const creatingRef = useRef(false)
  const { addToast } = useToast()

  const loadConversations = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.cerpAPI.listConversations(1, 50)
      if (result?.data) {
        setConversations(result.data)
      }
      setConversationsError(result?.error ?? null)
    } catch (err) {
      console.error('Failed to load conversations:', err)
      setConversationsError('network')
      addToast('error', 'No se pudieron cargar las conversaciones')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  // Load on mount
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const createConversation = useCallback(async (
    title: string,
    agentName: string,
    sessionId?: string,
    activeContextId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string | null> => {
    if (creatingRef.current) return null
    creatingRef.current = true
    try {
      const result = await window.cerpAPI.createConversation({
        title,
        agentName,
        sessionId,
        activeContextId,
        metadata,
      })
      if (result?.data) {
        const conv = result.data
        setActiveConversationId(conv._id)
        setConversations((prev) => [
          { _id: conv._id, title: conv.title, agentName: conv.agentName, updatedAt: conv.updatedAt || new Date().toISOString(), messageCount: 0 },
          ...prev,
        ])
        return conv._id
      }
      return null
    } catch (err) {
      console.error('Failed to create conversation:', err)
      addToast('error', 'No se pudo crear la conversación')
      return null
    } finally {
      creatingRef.current = false
    }
  }, [addToast])

  const appendMessage = useCallback(async (message: ChatMessage, metadata?: Record<string, unknown>, conversationId?: string) => {
    const convId = conversationId || activeConversationId
    if (!convId) return

    // No persistir turnos de assistant vacios: si el stream se corta antes del
    // primer token (idle timeout, error), queda un mensaje {role:'assistant',
    // content:''} sin tools. Guardarlo ensucia el historial con burbujas en
    // blanco. Un turno solo-herramienta (sin texto pero con tools) SI se guarda.
    if (
      message.role === 'assistant' &&
      !message.content?.trim() &&
      !(message.tools && message.tools.length > 0)
    ) {
      return
    }

    // Fire-and-forget: don't block UI
    const msgPayload = {
      role: message.role,
      content: message.content,
      agentContext: message.agentContext,
      tools: message.tools?.map((t) => ({
        name: t.name,
        input: t.input,
        output: t.output,
        status: t.status,
        startTime: t.startTime,
        endTime: t.endTime,
        agentName: t.agentName,
        // Antes se descartaban al persistir — el tipo del backend ya los contempla
        // (ver ipc/types.ts ConversationMessage), pero nadie los mandaba en el payload.
        subagentSteps: t.subagentSteps,
        subagentText: t.subagentText,
      })),
      // Lienzos HTML de show_html — el backend ya declara este campo en su
      // MessageSchema (cerp-server DesktopConversation.ts, maxlength 262144 por
      // html), así que sobrevive a un reload. Tope defensivo acá de todos modos:
      // un turno con muchos lienzos infla el documento de Mongo sin aportar nada
      // (el chat ya los mostró todos en vivo) — cortamos a los primeros 5.
      htmlCanvases: message.htmlCanvases?.slice(0, MAX_HTML_CANVASES_PER_MESSAGE),
      timestamp: message.timestamp,
    }

    window.cerpAPI.appendConversationMessage(convId, msgPayload, metadata).catch((err) => {
      console.error('Failed to append message:', err)
      addToast('warning', 'No se pudo guardar el mensaje en el historial')
    })

    // Update local summary
    setConversations((prev) =>
      prev.map((c) =>
        c._id === convId
          ? { ...c, updatedAt: new Date().toISOString(), messageCount: c.messageCount + 1 }
          : c,
      ),
    )
  }, [activeConversationId, addToast])

  const loadConversation = useCallback(async (id: string): Promise<{ messages: ChatMessage[]; cwd: string | null } | null> => {
    try {
      const result = await window.cerpAPI.getConversation(id)
      if (result?.data) {
        setActiveConversationId(id)
        // Convert backend messages to ChatMessage format
        const messages: ChatMessage[] = result.data.messages.map((m: any) => ({
          role: m.role,
          content: m.content,
          agentContext: m.agentContext,
          tools: m.tools?.map((t: any) => ({
            name: t.name,
            input: t.input,
            output: t.output,
            // Antes esto forzaba 'done' siempre — las tools que habían fallado
            // quedaban en verde al recargar la conversación. Preservamos el status
            // real persistido; solo caemos a 'done' si el campo directamente falta
            // (registros viejos, previos a que se guardara este dato).
            status: normalizeToolStatus(t.status),
            timestamp: t.startTime || m.timestamp,
            startTime: t.startTime || m.timestamp,
            endTime: t.endTime || t.startTime || m.timestamp,
            agentName: t.agentName,
            subagentSteps: t.subagentSteps?.map((s: any) => ({
              toolUseId: s.toolUseId,
              name: s.name,
              input: s.input,
              output: s.output,
              status: normalizeToolStatus(s.status),
              startTime: s.startTime,
              endTime: s.endTime,
            })),
            subagentText: t.subagentText,
          })),
          htmlCanvases: m.htmlCanvases,
          timestamp: m.timestamp,
        }))
        // La carpeta de trabajo persistida de ESTA conversación (metadata.cwd) —
        // se restaura junto con los mensajes para que el chip muestre la carpeta
        // correcta y no la de la última conversación tocada.
        return { messages, cwd: result.data.metadata?.cwd ?? null }
      }
      // 'auth' ya dispara el modal global de sesión expirada — no duplicar el aviso.
      if (result?.error && result.error !== 'auth') {
        addToast('error', 'No se pudo cargar la conversación')
      }
      return null
    } catch (err) {
      console.error('Failed to load conversation:', err)
      addToast('error', 'No se pudo cargar la conversación')
      return null
    }
  }, [addToast])

  const deleteConversation = useCallback(async (id: string) => {
    const result = await window.cerpAPI.deleteConversation(id)
    if (result) {
      setConversations((prev) => prev.filter((c) => c._id !== id))
      if (activeConversationId === id) {
        setActiveConversationId(null)
      }
    }
    return result
  }, [activeConversationId])

  const clearActiveConversation = useCallback(() => {
    setActiveConversationId(null)
  }, [])

  /** Marca una conversación como activa SIN recargarla de la DB (para conversaciones
   *  que ya están vivas en el store corriendo en segundo plano). */
  const setActiveConversation = useCallback((id: string | null) => {
    setActiveConversationId(id)
  }, [])

  return {
    conversations,
    activeConversationId,
    loading,
    conversationsError,
    loadConversations,
    createConversation,
    appendMessage,
    loadConversation,
    deleteConversation,
    clearActiveConversation,
    setActiveConversation,
  }
}
