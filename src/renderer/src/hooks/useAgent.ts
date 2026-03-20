import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentStreamEvent } from '../../../preload/index'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolName?: string
  timestamp: number
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentAssistantText = useRef('')

  useEffect(() => {
    const unsubMessage = window.cerpAPI.onAgentMessage((event: AgentStreamEvent) => {
      switch (event.type) {
        case 'text': {
          currentAssistantText.current = event.text
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: event.text }]
            }
            return [
              ...prev,
              { role: 'assistant', content: event.text, timestamp: Date.now() },
            ]
          })
          break
        }
        case 'tool_start':
          setActiveTool(event.name)
          break
        case 'tool_done':
          setActiveTool(null)
          break
        case 'status':
          // Could show in UI
          break
        case 'done':
          setIsStreaming(false)
          setActiveTool(null)
          break
        case 'error':
          setError(event.message)
          setIsStreaming(false)
          setActiveTool(null)
          break
      }
    })

    const unsubDone = window.cerpAPI.onAgentDone(() => {
      setIsStreaming(false)
      setActiveTool(null)
      currentAssistantText.current = ''
    })

    const unsubError = window.cerpAPI.onAgentError((err) => {
      setError(err.message)
      setIsStreaming(false)
    })

    return () => {
      unsubMessage()
      unsubDone()
      unsubError()
    }
  }, [])

  const sendPrompt = useCallback(async (prompt: string) => {
    setError(null)
    setIsStreaming(true)
    currentAssistantText.current = ''

    setMessages((prev) => [...prev, { role: 'user', content: prompt, timestamp: Date.now() }])

    const result = await window.cerpAPI.sendPrompt({ prompt })
    if (!result.started) {
      setError(result.error || 'No se pudo iniciar la consulta')
      setIsStreaming(false)
    }
  }, [])

  const abort = useCallback(async () => {
    await window.cerpAPI.abortAgent()
    setIsStreaming(false)
    setActiveTool(null)
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  return { messages, isStreaming, activeTool, error, sendPrompt, abort, clearMessages }
}
