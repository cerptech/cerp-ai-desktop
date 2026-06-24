import { useState, useCallback, useEffect, useRef } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ChatContainer } from '@/components/chat/ChatContainer'
import { ConversationPanel } from '@/components/conversations/ConversationPanel'
import { CustomAgentModal } from '@/components/settings/CustomAgentModal'
import { ContextModal } from '@/components/settings/ContextModal'
import { AddCustomMenu } from '@/components/settings/AddCustomMenu'
import { useCustomAgents } from '@/hooks/useCustomAgents'
import { useConversations } from '@/hooks/useConversations'
import { useOnboarding } from '@/hooks/useOnboarding'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import { getRuntime, restoreMessages as storeRestore, clearRuntime, setPersistHandler } from '@/stores/agentRuntimeStore'
import type { CustomAgent, CustomContext } from '../../../preload/index'

interface ChatPageProps {
  userName?: string
  onLogout: () => void
}

export function ChatPage({ userName, onLogout }: ChatPageProps) {
  const [activeAgents, setActiveAgents] = useState<string[]>([])
  const [doneAgents, setDoneAgents] = useState<string[]>([])
  // Whether the agent session is actively working — surfaced as a badge in
  // the top bar so the user always knows if the AI is thinking or idle.
  const [sessionActive, setSessionActive] = useState(false)
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
    setActiveConversation,
  } = useConversations()

  // Ref for the sidebar search input — used by Ctrl/Cmd+K shortcut in ChatContainer
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Refs the onboarding wizard uses to wire its steps to the real chat.
  const setCwdRef = useRef<((path: string) => void) | null>(null)
  const setInputRef = useRef<((text: string) => void) | null>(null)

  // Onboarding guided tutorial (Idea 1)
  const { progress: onboardingProgress, shouldAutoShow, viewStep, completeStep, skip: skipOnboarding, complete: completeOnboarding } = useOnboarding()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const onboardingAutoOpened = useRef(false)

  useEffect(() => {
    if (shouldAutoShow && !onboardingAutoOpened.current) {
      onboardingAutoOpened.current = true
      setShowOnboarding(true)
    }
  }, [shouldAutoShow])

  const handleConnectFolderFromWizard = useCallback(async (): Promise<string | null> => {
    const path = await window.cerpAPI.selectFolder()
    if (path) setCwdRef.current?.(path)
    return path
  }, [])

  const handleUsePromptFromWizard = useCallback((text: string) => {
    setInputRef.current?.(text)
  }, [])

  // El store persiste TODOS los mensajes (incluidas conversaciones de fondo) vía
  // appendMessage. Registramos el handler una vez.
  useEffect(() => {
    setPersistHandler((conversationId, message) => {
      appendMessage(message, undefined, conversationId)
    })
    return () => setPersistHandler(null)
  }, [appendMessage])

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
    // active=null muestra la pantalla nueva vacía. Las otras conversaciones
    // siguen corriendo en el store; NO se cierra ninguna sesión.
    clearActiveConversation()
  }, [clearActiveConversation])

  const handleSelectConversation = useCallback(async (id: string) => {
    setActiveAgents([])
    setDoneAgents([])
    // Si la conversación ya está viva en el store (corriendo o ya cargada), solo
    // la mostramos — NO la recargamos de la DB para no pisar su estado en vivo.
    const rt = getRuntime(id)
    if (rt.messages.length > 0 || rt.isStreaming) {
      setActiveConversation(id)
      return
    }
    // Primera vez que se abre en esta sesión: cargar de la DB y sembrar el runtime.
    const messages = await loadConversation(id) // setea active + devuelve mensajes
    if (messages) storeRestore(id, messages)
  }, [loadConversation, setActiveConversation])

  const handleDeleteConversation = useCallback(async (id: string) => {
    await deleteConv(id)
    clearRuntime(id)
  }, [deleteConv])

  // Crea una conversación si no hay activa, devolviendo su id real para enviar.
  const ensureConversation = useCallback(async (title: string): Promise<string | null> => {
    if (activeConversationId) return activeConversationId
    return await createConversation(title, 'orchestrator') // setea active
  }, [activeConversationId, createConversation])

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
      sessionActive={sessionActive}
      onShowOnboarding={() => setShowOnboarding(true)}
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
          activeConversationId={activeConversationId}
          ensureConversation={ensureConversation}
          onAgentActivity={handleAgentActivity}
          onNewConversation={handleNewConversation}
          searchInputRef={searchInputRef}
          onSessionActiveChange={setSessionActive}
          setCwdRef={setCwdRef}
          setInputRef={setInputRef}
        />
      </div>

      {/* Onboarding guided tutorial (Idea 1) */}
      {showOnboarding && (
        <OnboardingWizard
          progress={onboardingProgress}
          onClose={() => setShowOnboarding(false)}
          onViewStep={viewStep}
          onCompleteStep={completeStep}
          onSkip={skipOnboarding}
          onComplete={completeOnboarding}
          onConnectFolder={handleConnectFolderFromWizard}
          onUsePrompt={handleUsePromptFromWizard}
        />
      )}

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
