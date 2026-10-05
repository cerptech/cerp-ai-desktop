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

  // El main ya cerró la sesión por su cuenta (p.ej. 403 NO_ACTIVE_COMPANY): solo
  // hay que reflejarlo en la UI, sin volver a pedir el logout.
  const markSignedOut = useCallback(() => {
    setAuthState({ isAuthenticated: false })
  }, [])

  return { ...authState, loading, login, logout, markSignedOut }
}
