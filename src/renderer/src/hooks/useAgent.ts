import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentStreamEvent, AskUserQuestionItem, UserAnswerPayload } from '../../../preload/index'

export interface SubagentStep {
  /** The subagent's own inner tool_use id — keys done→start (never by name). */
  toolUseId?: string
  name: string
  input?: string
  output?: string
  status: 'running' | 'done' | 'error'
  startTime: number
  endTime?: number
}

export interface ToolExecution {
  name: string
  input?: string
  output?: string
  status: 'running' | 'done' | 'error'
  timestamp: number
  startTime: number
  endTime?: number
  agentName?: string
  /** Tool_use_id of the Agent delegation — used to key subagentSteps */
  toolUseId?: string
  /** Inner tool calls the subagent made, accumulated as subagent_tool_start/done events arrive */
  subagentSteps?: SubagentStep[]
  /** Latest text/reasoning streamed from the subagent (forwardSubagentText, Fase 2) */
  subagentText?: string
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
  // When true, the next `text` event must START a NEW assistant message
  // instead of updating the last one. Set after ask_user_question + answer
  // round-trips so the agent's new turn doesn't overwrite the context that
  // preceded the widget.
  const needsNewAssistantRef = useRef(false)
  // Bug #4: When true, we are waiting for the agent to resume after the user
  // submitted answers to ask_user_question. We block `done`/`onAgentDone`
  // from resetting isStreaming/isPending until the first real stream event
  // arrives, preventing a blank loading gap.
  const waitingAfterAnswerRef = useRef(false)
  // Live mirror of `messages` — sendPrompt snapshots this without depending
  // on the `messages` state in useCallback deps (which would re-create the
  // callback on every keystroke that changes the chat).
  const messagesRef = useRef<ChatMessage[]>([])

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

  // Keep messagesRef in sync with messages — used by sendPrompt to snapshot
  // history without re-creating the callback on every chat update.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

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
      // 60s with no event = true stall. The main process sends a stream_start heartbeat
      // every ~4s during streaming, so a legit long reasoning pause won't trip this.
      if (Date.now() - lastEventRef.current > 60_000) {
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
      // The agent will start a NEW turn after the user answers. Mark the next
      // `text` event so it appends a new assistant message instead of
      // overwriting the last one (which has the "voy a hacerte preguntas..."
      // context the user is reading above the widget).
      needsNewAssistantRef.current = true
      // The agent is now "streaming" but waiting — keep isStreaming true
      // so the UI shows the waiting state correctly
    })

    const unsubMessage = window.cerpAPI.onAgentMessage((event: AgentStreamEvent) => {
      if (!acceptingRef.current) return // Ignore stale events after conversation switch
      lastEventRef.current = Date.now()

      // Bug #2: stream_start is a pure signal — flip isStreaming/isPending on, no other state change.
      if (event.type === 'stream_start') {
        setIsStreaming(true)
        setIsPending(false)
        return
      }

      // Clear pending state on the very first real event — the agent has started responding.
      // Also clear the waitingAfterAnswer gate so done events resume normal handling.
      setIsPending(false)
      waitingAfterAnswerRef.current = false

      switch (event.type) {
        case 'text': {
          // If a previous turn ended with ask_user_question, the next text must
          // be a NEW assistant message so we don't overwrite the pre-widget context.
          if (needsNewAssistantRef.current) {
            needsNewAssistantRef.current = false
            toolsRef.current = []
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: event.text,
              timestamp: Date.now(),
              tools: [],
              agentContext: currentDelegationRef.current || undefined,
            }])
            break
          }
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
          const isAgentTool = event.name === 'Agent' || event.name === 'Task'
          // Every tool carries its tool_use id — the ToolExecution is keyed by it,
          // and tool_done matches by id (never by name). Agent/Task tools also own
          // a subagentSteps array, keyed by the same id via parentToolUseId.
          const tool: ToolExecution = {
            name: event.name,
            input: event.input,
            status: 'running',
            timestamp: now,
            startTime: now,
            toolUseId: event.toolUseId,
            ...(isAgentTool ? { subagentSteps: [] } : {}),
          }
          toolsRef.current = [...toolsRef.current, tool]
          setActiveTool(event.name)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'tool_done': {
          const now = Date.now()
          // Match by tool_use id — the only reliable key. Name matching broke because
          // SDK tool results don't carry the tool name and names can repeat.
          const doneTool = toolsRef.current.find((t) => t.toolUseId === event.toolUseId)
          const isAgentTool = doneTool?.name === 'Agent' || doneTool?.name === 'Task'
          toolsRef.current = toolsRef.current.map((t) =>
            t.toolUseId === event.toolUseId && t.status === 'running'
              ? {
                  ...t,
                  status: (event.isError ? 'error' : 'done') as ToolExecution['status'],
                  output: event.output,
                  endTime: now,
                  // mark any still-running subagent steps as done when the delegation closes
                  ...(t.subagentSteps
                    ? {
                        subagentSteps: t.subagentSteps.map((s) =>
                          s.status === 'running' ? { ...s, status: 'done' as const, endTime: now } : s,
                        ),
                      }
                    : {}),
                }
              : t,
          )
          if (isAgentTool) {
            currentDelegationRef.current = null
            setActiveAgentDelegation(null)
          }
          const stillRunning = toolsRef.current.find((t) => t.status === 'running')
          setActiveTool(stillRunning?.name || null)
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'agent_delegation': {
          const delegation = event as { type: 'agent_delegation'; toolUseId: string; agentName: string; task: string }
          currentDelegationRef.current = delegation.agentName
          setActiveAgentDelegation({ agentName: delegation.agentName, task: delegation.task })
          // Backfill agentName onto the exact Agent ToolExecution by tool_use id.
          toolsRef.current = toolsRef.current.map((t) =>
            t.toolUseId === delegation.toolUseId ? { ...t, agentName: delegation.agentName } : t,
          )
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'subagent_tool_start': {
          // A tool call inside a delegated subagent — nest it under the Agent tool whose
          // tool_use id === parentToolUseId. Concurrency-safe: parallel subagents each
          // resolve to their own ToolExecution by id.
          const ev = event as { type: 'subagent_tool_start'; parentToolUseId: string; toolUseId: string; agentName: string; name: string; input?: string }
          const now = Date.now()
          const newStep: SubagentStep = {
            toolUseId: ev.toolUseId,
            name: ev.name,
            input: ev.input,
            status: 'running',
            startTime: now,
          }
          toolsRef.current = toolsRef.current.map((t) =>
            t.toolUseId === ev.parentToolUseId
              ? { ...t, subagentSteps: [...(t.subagentSteps ?? []), newStep] }
              : t,
          )
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'subagent_tool_done': {
          // Result of an inner subagent tool call — mark the matching step done by its id.
          const ev = event as { type: 'subagent_tool_done'; parentToolUseId: string; toolUseId: string; output?: string; isError?: boolean }
          const now = Date.now()
          toolsRef.current = toolsRef.current.map((t) => {
            if (t.toolUseId !== ev.parentToolUseId || !t.subagentSteps) return t
            return {
              ...t,
              subagentSteps: t.subagentSteps.map((s) =>
                s.toolUseId === ev.toolUseId && s.status === 'running'
                  ? { ...s, status: (ev.isError ? 'error' : 'done') as SubagentStep['status'], output: ev.output, endTime: now }
                  : s,
              ),
            }
          })
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
        case 'subagent_text': {
          // Live text/reasoning from the subagent (forwardSubagentText) — show under its Agent tool.
          const ev = event as { type: 'subagent_text'; parentToolUseId: string; agentName: string; text: string }
          toolsRef.current = toolsRef.current.map((t) =>
            t.toolUseId === ev.parentToolUseId ? { ...t, subagentText: ev.text } : t,
          )
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
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
          // Bug #4: If the user just submitted ask_user_question answers and the agent
          // hasn't yet emitted any response, a stale `done` from the prior turn may arrive
          // and reset isStreaming/isPending prematurely, causing a blank loading gap.
          // We hold off resetting these flags while waitingAfterAnswerRef is set.
          if (waitingAfterAnswerRef.current) break
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
        case 'error': {
          setError((event as { type: 'error'; message: string }).message)
          setIsStreaming(false)
          setIsPending(false)
          setActiveTool(null)
          setActiveAgentDelegation(null)
          currentDelegationRef.current = null
          // Mark any running tools as errored
          const now = Date.now()
          toolsRef.current = toolsRef.current.map((t) =>
            t.status === 'running' ? { ...t, status: 'error' as const, endTime: now } : t,
          )
          updateLastAssistant((msg) => ({ ...msg, tools: [...toolsRef.current] }))
          break
        }
      }
    })

    const unsubDone = window.cerpAPI.onAgentDone(() => {
      if (!acceptingRef.current) return // Ignore stale events after conversation switch
      // Bug #4: while waiting for the agent to resume after ask_user_question answers,
      // do not reset isStreaming/isPending — that would cause a blank loading gap.
      if (waitingAfterAnswerRef.current) return
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
    waitingAfterAnswerRef.current = false // Clear answer-wait gate on new user prompt
    setError(null)
    setIsStreaming(true)
    setIsPending(true) // Show loader immediately — before the first stream event arrives
    setActiveTool(null)
    setActiveAgentDelegation(null)
    setPromptSuggestions([])
    setStatusMessage(null)
    currentDelegationRef.current = null
    toolsRef.current = []

    // Snapshot history BEFORE we append the new user message — we want the
    // main process to inject the prior turns into the system prompt only if
    // it starts a fresh SDK session (Plan Mode toggle, restored conversation
    // or cwd/context change). When the SDK session is already open, the main
    // process ignores conversationHistory because the SDK already has it.
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }))

    setMessages((prev) => [...prev, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }])

    const result = await window.cerpAPI.sendPrompt({
      prompt,
      cwd,
      activeContextId,
      conversationHistory: history,
    })
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
    needsNewAssistantRef.current = false
    waitingAfterAnswerRef.current = false
    currentDelegationRef.current = null
  }, [])

  /**
   * Submit the user's answers to the pending ask_user_question.
   * Resumes agent execution on the main process side.
   */
  const submitAnswers = useCallback(async (answers: UserAnswerPayload) => {
    if (!pendingQuestions) return

    // Audit trail: append a user message with the formatted answers so the
    // conversation has a record of what the user chose in the widget.
    // Otherwise the widget disappears and the agent's next turn replies into
    // the void — no record of the decisions for review or screenshots.
    const echoLines = pendingQuestions.map((q) => {
      const ans = answers[q.question]
      const ansText = Array.isArray(ans) ? ans.join(', ') : (ans ?? '(sin respuesta)')
      return `- **${q.header}**: ${ansText}`
    }).join('\n')
    const echoContent = pendingQuestions.length === 1
      ? `Respuesta: ${echoLines.replace(/^- \*\*[^*]+\*\*: /, '')}`
      : `Respondí:\n${echoLines}`
    setMessages((prev) => [...prev, {
      role: 'user',
      content: echoContent,
      timestamp: Date.now(),
    }])

    setIsSubmittingAnswers(true)
    // Bug #4: arm the waitingAfterAnswer gate BEFORE calling submitUserAnswers.
    // This prevents any stale `done`/`onAgentDone` from resetting isStreaming/isPending
    // while the agent is resuming. The gate is cleared on the first real stream event.
    waitingAfterAnswerRef.current = true
    // Re-arm activity indicators so the user sees a "trabajando..." state in the
    // window between closing the widget and the agent's next text event.
    // Without these, isStreaming may already be false (turn done event arrived
    // before the tool resolved) and there's a blank-screen ~1-3s gap.
    setIsPending(true)
    setIsStreaming(true)
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
    needsNewAssistantRef.current = false
    waitingAfterAnswerRef.current = false
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
    needsNewAssistantRef.current = false
    waitingAfterAnswerRef.current = false
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
