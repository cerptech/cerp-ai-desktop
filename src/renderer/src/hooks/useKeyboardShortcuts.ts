import { useEffect, type RefObject } from 'react'

interface UseKeyboardShortcutsOptions {
  /** Called when Ctrl/Cmd+N is pressed (new conversation). */
  onNewConversation: () => void
  /** Ref to the sidebar search input. Focused on Ctrl/Cmd+K. Falls back to chatInputRef. */
  searchInputRef?: RefObject<HTMLInputElement | null>
  /** Ref to the chat textarea. Used as fallback for Ctrl/Cmd+K when sidebar search is absent. */
  chatInputRef?: RefObject<HTMLTextAreaElement | null>
}

/**
 * Registers global keyboard shortcuts for CERP AI Desktop chat.
 *
 * Ctrl/Cmd+N — new conversation
 * Ctrl/Cmd+K — focus sidebar search (or chat input as fallback)
 *
 * Local input shortcuts (Enter, Shift+Enter, Escape) are handled directly
 * in the textarea's onKeyDown handler — not here.
 */
export function useKeyboardShortcuts({
  onNewConversation,
  searchInputRef,
  chatInputRef,
}: UseKeyboardShortcutsOptions): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = e.ctrlKey || e.metaKey

      // Ctrl/Cmd+N — new conversation
      if (isMod && e.key === 'n') {
        // Only intercept when not inside a native text input to avoid stealing
        // browser/OS shortcuts from other focused inputs (e.g. address bars).
        const tag = (document.activeElement as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          onNewConversation()
        }
        // Also handle when the chat textarea itself is focused — the user
        // explicitly wants a new conversation via the shortcut.
        if (document.activeElement === chatInputRef?.current) {
          e.preventDefault()
          onNewConversation()
        }
        return
      }

      // Ctrl/Cmd+K — focus sidebar search (or chat input fallback)
      if (isMod && e.key === 'k') {
        e.preventDefault()
        const searchEl = searchInputRef?.current
        if (searchEl) {
          searchEl.focus()
          searchEl.select()
        } else {
          chatInputRef?.current?.focus()
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onNewConversation, searchInputRef, chatInputRef])
}
