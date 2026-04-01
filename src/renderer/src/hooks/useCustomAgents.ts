import { useState, useEffect, useCallback } from 'react'
import type { CustomAgent, CustomContext } from '../../../preload/index'
import { useToast } from './useToast'

export function useCustomAgents() {
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [contexts, setContexts] = useState<CustomContext[]>([])
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()

  const refresh = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        window.cerpAPI.listCustomAgents(),
        window.cerpAPI.listCustomContexts(),
      ])
      setAgents(a)
      setContexts(c)
    } catch (err) {
      console.error('Failed to load custom agents/contexts:', err)
      addToast('error', 'No se pudieron cargar los agentes personalizados')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createAgent = useCallback(async (data: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    const agent = await window.cerpAPI.createCustomAgent(data)
    setAgents((prev) => [...prev, agent])
    return agent
  }, [])

  const updateAgent = useCallback(async (id: string, updates: Partial<CustomAgent>) => {
    const updated = await window.cerpAPI.updateCustomAgent(id, updates)
    if (updated) {
      setAgents((prev) => prev.map((a) => (a.id === id ? updated : a)))
    }
    return updated
  }, [])

  const deleteAgent = useCallback(async (id: string) => {
    const result = await window.cerpAPI.deleteCustomAgent(id)
    if (result) {
      setAgents((prev) => prev.filter((a) => a.id !== id))
    }
    return result
  }, [])

  const createContext = useCallback(async (data: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>) => {
    const ctx = await window.cerpAPI.createCustomContext(data)
    setContexts((prev) => [...prev, ctx])
    return ctx
  }, [])

  const updateContext = useCallback(async (id: string, updates: Partial<CustomContext>) => {
    const updated = await window.cerpAPI.updateCustomContext(id, updates)
    if (updated) {
      setContexts((prev) => prev.map((c) => (c.id === id ? updated : c)))
    }
    return updated
  }, [])

  const deleteContext = useCallback(async (id: string) => {
    const result = await window.cerpAPI.deleteCustomContext(id)
    if (result) {
      setContexts((prev) => prev.filter((c) => c.id !== id))
    }
    return result
  }, [])

  return {
    agents,
    contexts,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    createContext,
    updateContext,
    deleteContext,
    refresh,
  }
}
