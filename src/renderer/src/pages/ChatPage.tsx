import { useState, useCallback, useRef } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ChatContainer, type ChatStateSnapshot } from '@/components/chat/ChatContainer'
import { AgentTags } from '@/components/agents/AgentTags'
import { ConversationPanel } from '@/components/conversations/ConversationPanel'
import { CustomAgentModal } from '@/components/settings/CustomAgentModal'
import { ContextModal } from '@/components/settings/ContextModal'
import { AddCustomMenu } from '@/components/settings/AddCustomMenu'
import { useCustomAgents } from '@/hooks/useCustomAgents'
import { useConversations } from '@/hooks/useConversations'
import type { CustomAgent, CustomContext } from '../../../preload/index'
import type { ChatMessage } from '@/hooks/useAgent'

interface ChatPageProps {
  userName?: string
  onLogout: () => void
}

export function ChatPage({ userName, onLogout }: ChatPageProps) {
  const [activeAgents, setActiveAgents] = useState<string[]>([])
  const [doneAgents, setDoneAgents] = useState<string[]>([])
  const [convPanelCollapsed, setConvPanelCollapsed] = useState(false)
  const [activeContextId, setActiveContextId] = useState<string | null>(null)

  // Custom agents/contexts
  const { agents: customAgents, contexts: customContexts, createAgent, createContext, updateAgent, updateContext, deleteAgent, deleteContext } = useCustomAgents()
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [showAgentModal, setShowAgentModal] = useState(false)
  const [showContextModal, setShowContextModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<CustomAgent | null>(null)
  const [editingContext, setEditingContext] = useState<CustomContext | null>(null)

  // Conversations
  const {
    conversations,
    activeConversationId,
    loading: convLoading,
    createConversation,
    appendMessage,
    loadConversation,
    deleteConversation: deleteConv,
    clearActiveConversation,
  } = useConversations()

  // Ref to pass restoreMessages from ChatContainer
  const restoreMessagesRef = useRef<((msgs: ChatMessage[]) => void) | null>(null)
  const clearMessagesRef = useRef<(() => void) | null>(null)
  const chatStateRef = useRef<ChatStateSnapshot | null>(null)
  // Ref for the sidebar search input — used by Ctrl/Cmd+K shortcut in ChatContainer
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const handleAgentActivity = (agentName: string, status: 'active' | 'done' | 'idle') => {
    if (status === 'active') {
      setActiveAgents((prev) => [...new Set([...prev, agentName])])
      setDoneAgents((prev) => prev.filter((a) => a !== agentName))
    } else if (status === 'done') {
      setActiveAgents((prev) => prev.filter((a) => a !== agentName))
      setDoneAgents((prev) => [...new Set([...prev, agentName])])
    } else {
      setActiveAgents((prev) => prev.filter((a) => a !== agentName))
      setDoneAgents((prev) => prev.filter((a) => a !== agentName))
    }
  }

  const handleNewConversation = useCallback(() => {
    setActiveAgents([])
    setDoneAgents([])
    clearActiveConversation()
    clearMessagesRef.current?.()
  }, [clearActiveConversation])

  const handleSelectConversation = useCallback(async (id: string) => {
    // If AI is streaming, abort and persist partial response to current conversation before switching
    const state = chatStateRef.current
    if (state?.isStreaming && activeConversationId) {
      await state.abort()
      const lastMsg = state.messages[state.messages.length - 1]
      if (lastMsg?.role === 'assistant' && lastMsg.content) {
        appendMessage(lastMsg)
      }
    }

    const messages = await loadConversation(id)
    if (messages) {
      restoreMessagesRef.current?.(messages)
      setActiveAgents([])
      setDoneAgents([])
    }
  }, [loadConversation, activeConversationId, appendMessage])

  const handleDeleteConversation = useCallback(async (id: string) => {
    await deleteConv(id)
    if (activeConversationId === id) {
      clearMessagesRef.current?.()
    }
  }, [deleteConv, activeConversationId])

  // Callback for when a message is completed (user or assistant)
  const handleMessageComplete = useCallback(async (message: ChatMessage) => {
    if (!activeConversationId) {
      const title = message.content.substring(0, 50) || 'Nueva conversacion'
      const convId = await createConversation(title, 'orchestrator')
      if (convId) {
        // Pass explicit convId because activeConversationId state hasn't updated yet
        appendMessage(message, undefined, convId)
      }
    } else {
      appendMessage(message)
    }
  }, [activeConversationId, createConversation, appendMessage])

  const handleAddCustom = () => setShowAddMenu(true)

  const handleEditAgent = (agent: CustomAgent) => {
    setEditingAgent(agent)
    setShowAgentModal(true)
  }

  const handleEditContext = (context: CustomContext) => {
    setEditingContext(context)
    setShowContextModal(true)
  }

  const handleToggleContext = (id: string) => {
    setActiveContextId((prev) => (prev === id ? null : id))
  }

  const handleSaveAgent = async (data: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingAgent) {
      await updateAgent(editingAgent.id, data)
    } else {
      await createAgent(data)
    }
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  const handleSaveContext = async (data: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingContext) {
      await updateContext(editingContext.id, data)
    } else {
      await createContext(data)
    }
    setShowContextModal(false)
    setEditingContext(null)
  }

  const handleDeleteAgent = async (id: string) => {
    await deleteAgent(id)
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  const handleDeleteContext = async (id: string) => {
    await deleteContext(id)
    if (activeContextId === id) setActiveContextId(null)
    setShowContextModal(false)
    setEditingContext(null)
  }

  return (
    <AppLayout
      userName={userName}
      onLogout={onLogout}
      agentTags={
        <AgentTags
          activeAgents={activeAgents}
          doneAgents={doneAgents}
          customAgents={customAgents}
          customContexts={customContexts}
          activeContextId={activeContextId}
          onEditAgent={handleEditAgent}
          onEditContext={handleEditContext}
          onToggleContext={handleToggleContext}
          onAdd={handleAddCustom}
        />
      }
    >
      <div className="flex h-full">
        <ConversationPanel
          conversations={conversations}
          activeConversationId={activeConversationId}
          loading={convLoading}
          collapsed={convPanelCollapsed}
          onToggleCollapse={() => setConvPanelCollapsed(!convPanelCollapsed)}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          searchInputRef={searchInputRef}
        />
        <ChatContainer
          userName={userName}
          activeContextId={activeContextId}
          onAgentActivity={handleAgentActivity}
          onNewConversation={handleNewConversation}
          onMessageComplete={handleMessageComplete}
          restoreMessagesRef={restoreMessagesRef}
          clearMessagesRef={clearMessagesRef}
          chatStateRef={chatStateRef}
          searchInputRef={searchInputRef}
        />
      </div>

      {/* Add custom menu */}
      {showAddMenu && (
        <AddCustomMenu
          onClose={() => setShowAddMenu(false)}
          onAddAgent={() => {
            setShowAddMenu(false)
            setEditingAgent(null)
            setShowAgentModal(true)
          }}
          onAddContext={() => {
            setShowAddMenu(false)
            setEditingContext(null)
            setShowContextModal(true)
          }}
        />
      )}

      {/* Custom agent modal */}
      {showAgentModal && (
        <CustomAgentModal
          agent={editingAgent}
          onSave={handleSaveAgent}
          onDelete={editingAgent ? () => handleDeleteAgent(editingAgent.id) : undefined}
          onClose={() => { setShowAgentModal(false); setEditingAgent(null) }}
        />
      )}

      {/* Context modal */}
      {showContextModal && (
        <ContextModal
          context={editingContext}
          onSave={handleSaveContext}
          onDelete={editingContext ? () => handleDeleteContext(editingContext.id) : undefined}
          onClose={() => { setShowContextModal(false); setEditingContext(null) }}
        />
      )}
    </AppLayout>
  )
}
