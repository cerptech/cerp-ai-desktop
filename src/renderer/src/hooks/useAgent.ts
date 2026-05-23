import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentStreamEvent, AskUserQuestionItem, UserAnswerPayload } from '../../../preload/index'

export interface ToolExecution {
  name: string
  input?: string
  output?: string
  status: 'running' | 'done'
  timestamp: number
  startTime: number
  endTime?: number
  agentName?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolExecution[]
  timestamp: number
  agentContext?: string
}

export interface AgentDelegation {
  agentName: string
  task: string
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  // isPending: true from the moment the user sends a message until the first stream event arrives.
  // This closes the brief blank-screen window that occurs before the backend sends any data.
  const [isPending, setIsPending] = useState(false)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeAgentDelegation, setActiveAgentDelegation] = useState<AgentDelegation | null>(null)
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  // Session-level cost and token accumulators — reset on clearMessages/restoreMessages
  const [sessionCost, setSessionCost] = useState(0)
  const [sessionTokensIn, setSessionTokensIn] = useState(0)
  const [sessionTokensOut, setSessionTokensOut] = useState(0)
  // ask_user_question state — set when the agent needs structured clarifications
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestionItem[] | null>(null)
  const [isSubmittingAnswers, setIsSubmittingAnswers] = useState(false)
  const toolsRef = useRef<ToolExecution[]>([])
  const lastEventRef = useRef<number>(Date.now())
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentDelegationRef = useRef<string | null>(null)
  // Gate to ignore stream events after a conversation switch
  const acceptingRef = useRef(true)

  const updateLastAssistant = useCallback((updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), updater(last)]
      }
      const newMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        tools: [],
        timestamp: Date.now(),
        agentContext: currentDelegationRef.current || undefined,
      }
      return [...prev, updater(newMsg)]
    })
  }, [])

  // Phase 1: Fallback timer to force-reset isStreaming after 30s of inactivity
  useEffect(() => {
    if (!isStreaming) {
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      return
    }
    fallbackTimerRef.current = setInterval(() => {
      if (!acceptingRef.current) return
      if (Date.now() - lastEventRef.current > 30_000) {
        setIsStreaming(false)
        setActiveTool(null)
        setActiveAgentDelegation(null)
        currentDelegationRef.current = null
        toolsRef.current = toolsRef.current.map((t) =>
          t.status === 'running' ? { ...t, status: 'done' as const, endTime: Date.now() } : t,
        )
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && toolsRef.current.length > 0) {
            return [...prev.slice(0, -1), { ...last, tools: [...toolsRef.current] }]
          }
          return prev
        })
      }
    }, 5_000)
    return () => {
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
    }
  }, [isStreaming])

  useEffect(() => {
    // Subscribe to structured question requests from the agent
    const unsubAsk = window.cerpAPI.onAskUserQuestion((questions) => {
      if (!acceptingRef.current) return
      setPendingQuestions(questions)
      // The agent is now "streaming" but waiting — keep isStreaming true
      // so the UI shows the waiting state correctly
    })

    const unsubMessage = window.cerpAPI.onAgentMessage((event: AgentStreamEvent) => {
      if (!acceptingRef.current) return // Ignore stale events after conversation switch
      lastEventRef.current = Date.now()
      // Clear pending state on the very first event — the agent has started responding
      setIsPending(false)

      switch (event.type) {
        case 'text': {
          updateLastAssistant((msg) => ({
            ...msg,
            content: event.text,
            tools: [...toolsRef.current],
            agentContext: currentDelegationRef.current || msg.agentContext,
          }))
          break
        }
        case 'tool_start': {
          const now = Date.now()
          // Detect agent delegation from Agent tool input
          let agentName: string | undefined
          if (event.name === 'Agent' && event.input) {
            // Try to extract agent name from input text
            const match = event.input.match(/(?:agent_name|name)["']?\s*[:=]\s*["']?([a-z-]+)/i)
            if (match) agentName = match[1]
          }
          const tool: ToolExecution = {
            name: event.name,
            input: event.input,
            status: 'running',
            timestamp: now,
            startTime: now,
            agentName,
          }
          toolsRef.current = [...toolsRef.current, tool]
          setActiveTool(event.name)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'tool_done': {
          const now = Date.now()
          let found = false
          toolsRef.current = toolsRef.current.map((t) => {
            if (!found && t.name === event.name && t.status === 'running') {
              found = true
              return { ...t, status: 'done' as const, output: event.output, endTime: now }
            }
            return t
          })
          // If an Agent tool just finished, clear delegation tracking
          if (event.name === 'Agent') {
            currentDelegationRef.current = null
            setActiveAgentDelegation(null)
          }
          const stillRunning = toolsRef.current.find((t) => t.status === 'running')
          setActiveTool(stillRunning?.name || null)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'agent_delegation': {
          const delegation = event as { type: 'agent_delegation'; agentName: string; task: string }
          currentDelegationRef.current = delegation.agentName
          setActiveAgentDelegation({ agentName: delegation.agentName, task: delegation.task })
          break
        }
        case 'prompt_suggestions': {
          const suggestions = (event as { type: 'prompt_suggestions'; suggestions: string[] }).suggestions
          setPromptSuggestions(suggestions)
          break
        }
        case 'status': {
          const msg = (event as { type: 'status'; message: string }).message
          if (msg) setStatusMessage(msg)
          break
        }
        case 'done': {
          const doneEvent = event as { type: 'done'; cost?: number; tokensIn?: number; tokensOut?: number }
          if (doneEvent.cost != null) setSessionCost((prev) => prev + doneEvent.cost!)
          if (doneEvent.tokensIn != null) setSessionTokensIn((prev) => prev + doneEvent.tokensIn!)
          if (doneEvent.tokensOut != null) setSessionTokensOut((prev) => prev + doneEvent.tokensOut!)
          setIsStreaming(false)
          setIsPending(false)
          setStatusMessage(null)
          setActiveTool(null)
          setActiveAgentDelegation(null)
          currentDelegationRef.current = null
          break
        }
        case 'error':
          setError((event as { type: 'error'; message: string }).message)
          setIsStreaming(false)
          setIsPending(false)
          setActiveTool(null)
          setActiveAgentDelegation(null)
          currentDelegationRef.current = null
          break
      }
    })

    const unsubDone = window.cerpAPI.onAgentDone(() => {
      if (!acceptingRef.current) return // Ignore stale events after conversation switch
      // Force stop everything
      setIsStreaming(false)
      setIsPending(false)
      setActiveTool(null)
      setActiveAgentDelegation(null)
      currentDelegationRef.current = null
      // Mark any remaining running tools as done
      const now = Date.now()
      toolsRef.current = toolsRef.current.map((t) =>
        t.status === 'running' ? { ...t, status: 'done' as const, endTime: now } : t,
      )
      // Force update last message with final tool states
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && toolsRef.current.length > 0) {
          return [...prev.slice(0, -1), { ...last, tools: [...toolsRef.current] }]
        }
        return prev
      })
      // Belt-and-suspenders: ensure isStreaming resets even with React batching
      setTimeout(() => setIsStreaming(false), 100)
    })

    const unsubError = window.cerpAPI.onAgentError((err) => {
      if (!acceptingRef.current) return // Ignore stale events after conversation switch
      setError(err.message)
      setIsStreaming(false)
      setIsPending(false)
      setActiveTool(null)
      setActiveAgentDelegation(null)
      currentDelegationRef.current = null
    })

    return () => {
      unsubAsk()
      unsubMessage()
      unsubDone()
      unsubError()
    }
  }, [updateLastAssistant])

  const sendPrompt = useCallback(async (prompt: string, cwd?: string, activeContextId?: string) => {
    acceptingRef.current = true // Accept events for this new prompt
    setError(null)
    setIsStreaming(true)
    setIsPending(true) // Show loader immediately — before the first stream event arrives
    setActiveTool(null)
    setActiveAgentDelegation(null)
    setPromptSuggestions([])
    setStatusMessage(null)
    currentDelegationRef.current = null
    toolsRef.current = []

    setMessages((prev) => [...prev, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }])

    const result = await window.cerpAPI.sendPrompt({ prompt, cwd, activeContextId })
    if (!result.started) {
      setError(result.error || 'No se pudo iniciar la consulta')
      setIsStreaming(false)
    }
  }, [])

  const abort = useCallback(async () => {
    await window.cerpAPI.abortAgent()
    setIsStreaming(false)
    setIsPending(false)
    setActiveTool(null)
    setActiveAgentDelegation(null)
    setPendingQuestions(null)
    setIsSubmittingAnswers(false)
    currentDelegationRef.current = null
  }, [])

  /**
   * Submit the user's answers to the pending ask_user_question.
   * Resumes agent execution on the main process side.
   */
  const submitAnswers = useCallback(async (answers: UserAnswerPayload) => {
    if (!pendingQuestions) return
    setIsSubmittingAnswers(true)
    try {
      await window.cerpAPI.submitUserAnswers(answers)
      setPendingQuestions(null)
    } finally {
      setIsSubmittingAnswers(false)
    }
  }, [pendingQuestions])

  const clearMessages = useCallback(() => {
    acceptingRef.current = false // Block stale stream events from previous conversation
    setMessages([])
    setIsStreaming(false)
    setIsPending(false)
    setActiveTool(null)
    setError(null)
    setActiveAgentDelegation(null)
    setPendingQuestions(null)
    setIsSubmittingAnswers(false)
    currentDelegationRef.current = null
    toolsRef.current = []
    setSessionCost(0)
    setSessionTokensIn(0)
    setSessionTokensOut(0)
  }, [])

  // Restore messages from a loaded conversation
  const restoreMessages = useCallback((loadedMessages: ChatMessage[]) => {
    acceptingRef.current = false // Block stale stream events from previous conversation
    setMessages(loadedMessages)
    setIsStreaming(false)
    setIsPending(false)
    setActiveTool(null)
    setError(null)
    setActiveAgentDelegation(null)
    setPendingQuestions(null)
    setIsSubmittingAnswers(false)
    currentDelegationRef.current = null
    toolsRef.current = []
    setSessionCost(0)
    setSessionTokensIn(0)
    setSessionTokensOut(0)
  }, [])

  return {
    messages,
    isStreaming,
    isPending,
    activeTool,
    error,
    activeAgentDelegation,
    promptSuggestions,
    statusMessage,
    sessionCost,
    sessionTokensIn,
    sessionTokensOut,
    pendingQuestions,
    isSubmittingAnswers,
    sendPrompt,
    abort,
    submitAnswers,
    clearMessages,
    restoreMessages,
  }
}
