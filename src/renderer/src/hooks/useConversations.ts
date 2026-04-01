import { useState, useEffect, useCallback, useRef } from 'react'
import type { ConversationSummary, ConversationFull } from '../../../preload/index'
import type { ChatMessage } from './useAgent'
import { useToast } from './useToast'

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const creatingRef = useRef(false)
  const { addToast } = useToast()

  const loadConversations = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.cerpAPI.listConversations(1, 50)
      if (result?.data) {
        setConversations(result.data)
      }
    } catch (err) {
      console.error('Failed to load conversations:', err)
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
      addToast('error', 'No se pudo crear la conversacion')
      return null
    } finally {
      creatingRef.current = false
    }
  }, [addToast])

  const appendMessage = useCallback(async (message: ChatMessage, metadata?: Record<string, unknown>, conversationId?: string) => {
    const convId = conversationId || activeConversationId
    if (!convId) return

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
      })),
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

  const loadConversation = useCallback(async (id: string): Promise<ChatMessage[] | null> => {
    try {
      const result = await window.cerpAPI.getConversation(id)
      if (result?.data) {
        setActiveConversationId(id)
        // Convert backend messages to ChatMessage format
        return result.data.messages.map((m: any) => ({
          role: m.role,
          content: m.content,
          agentContext: m.agentContext,
          tools: m.tools?.map((t: any) => ({
            name: t.name,
            input: t.input,
            output: t.output,
            status: t.status || 'done',
            timestamp: t.startTime || m.timestamp,
            startTime: t.startTime || m.timestamp,
            endTime: t.endTime,
            agentName: t.agentName,
          })),
          timestamp: m.timestamp,
        }))
      }
      return null
    } catch (err) {
      console.error('Failed to load conversation:', err)
      addToast('error', 'No se pudo cargar la conversacion')
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

  return {
    conversations,
    activeConversationId,
    loading,
    loadConversations,
    createConversation,
    appendMessage,
    loadConversation,
    deleteConversation,
    clearActiveConversation,
  }
}
