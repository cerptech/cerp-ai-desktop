import { AppLayout } from '@/components/layout/AppLayout'
import { ChatContainer } from '@/components/chat/ChatContainer'

interface ChatPageProps {
  userName?: string
  onLogout: () => void
}

export function ChatPage({ userName, onLogout }: ChatPageProps) {
  return (
    <AppLayout userName={userName} onLogout={onLogout}>
      <ChatContainer userName={userName} />
    </AppLayout>
  )
}
