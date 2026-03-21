import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentStreamEvent } from '../../../preload/index'

export interface ToolExecution {
  name: string
  input?: string
  output?: string
  status: 'running' | 'done'
  timestamp: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolExecution[]
  timestamp: number
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toolsRef = useRef<ToolExecution[]>([])

  const updateLastAssistant = useCallback((updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), updater(last)]
      }
      const newMsg: ChatMessage = { role: 'assistant', content: '', tools: [], timestamp: Date.now() }
      return [...prev, updater(newMsg)]
    })
  }, [])

  useEffect(() => {
    const unsubMessage = window.cerpAPI.onAgentMessage((event: AgentStreamEvent) => {
      switch (event.type) {
        case 'text': {
          updateLastAssistant((msg) => ({
            ...msg,
            content: event.text,
            tools: [...toolsRef.current],
          }))
          break
        }
        case 'tool_start': {
          const tool: ToolExecution = {
            name: event.name,
            input: event.input,
            status: 'running',
            timestamp: Date.now(),
          }
          toolsRef.current = [...toolsRef.current, tool]
          setActiveTool(event.name)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'tool_done': {
          // Mark the LAST running tool with this name as done
          let found = false
          toolsRef.current = toolsRef.current.map((t) => {
            if (!found && t.name === event.name && t.status === 'running') {
              found = true
              return { ...t, status: 'done' as const, output: event.output }
            }
            return t
          })
          // Check if any tools still running
          const stillRunning = toolsRef.current.find((t) => t.status === 'running')
          setActiveTool(stillRunning?.name || null)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'done':
          // Final done from mapMessage — stop streaming
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
      // Force stop everything
      setIsStreaming(false)
      setActiveTool(null)
      // Mark any remaining running tools as done
      toolsRef.current = toolsRef.current.map((t) =>
        t.status === 'running' ? { ...t, status: 'done' as const } : t,
      )
      // Force update last message with final tool states
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && toolsRef.current.length > 0) {
          return [...prev.slice(0, -1), { ...last, tools: [...toolsRef.current] }]
        }
        return prev
      })
    })

    const unsubError = window.cerpAPI.onAgentError((err) => {
      setError(err.message)
      setIsStreaming(false)
      setActiveTool(null)
    })

    return () => {
      unsubMessage()
      unsubDone()
      unsubError()
    }
  }, [updateLastAssistant])

  const sendPrompt = useCallback(async (prompt: string, cwd?: string) => {
    setError(null)
    setIsStreaming(true)
    setActiveTool(null)
    toolsRef.current = []

    setMessages((prev) => [...prev, { role: 'user', content: prompt, timestamp: Date.now() }])

    const result = await window.cerpAPI.sendPrompt({ prompt, cwd })
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
    toolsRef.current = []
  }, [])

  return { messages, isStreaming, activeTool, error, sendPrompt, abort, clearMessages }
}
