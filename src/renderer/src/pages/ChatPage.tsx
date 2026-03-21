import { useState } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ChatContainer } from '@/components/chat/ChatContainer'
import { AgentPanel } from '@/components/agents/AgentPanel'

interface ChatPageProps {
  userName?: string
  onLogout: () => void
}

export function ChatPage({ userName, onLogout }: ChatPageProps) {
  const [selectedAgent, setSelectedAgent] = useState('orchestrator')
  const [activeAgents, setActiveAgents] = useState<string[]>([])
  const [doneAgents, setDoneAgents] = useState<string[]>([])
  const [panelCollapsed, setPanelCollapsed] = useState(false)

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

  const handleNewConversation = () => {
    setActiveAgents([])
    setDoneAgents([])
    setSelectedAgent('orchestrator')
  }

  return (
    <AppLayout userName={userName} onLogout={onLogout}>
      <div className="flex h-full">
        <AgentPanel
          selectedAgent={selectedAgent}
          activeAgents={activeAgents}
          doneAgents={doneAgents}
          onSelectAgent={setSelectedAgent}
          collapsed={panelCollapsed}
          onToggleCollapse={() => setPanelCollapsed(!panelCollapsed)}
        />
        <ChatContainer
          userName={userName}
          selectedAgent={selectedAgent}
          onAgentActivity={handleAgentActivity}
          onNewConversation={handleNewConversation}
        />
      </div>
    </AppLayout>
  )
}
