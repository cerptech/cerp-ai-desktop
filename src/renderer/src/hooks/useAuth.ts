import { useState, useEffect, useCallback } from 'react'
import type { AuthState } from '../../../preload/index'

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({ isAuthenticated: false })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.cerpAPI.getAuthStatus().then((state) => {
      setAuthState(state)
      setLoading(false)
    })
  }, [])

  const login = useCallback(async () => {
    setLoading(true)
    try {
      const state = await window.cerpAPI.login()
      setAuthState(state)
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    await window.cerpAPI.logout()
    setAuthState({ isAuthenticated: false })
  }, [])

  return { ...authState, loading, login, logout }
}
