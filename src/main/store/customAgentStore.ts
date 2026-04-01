import { app } from 'electron'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { logger } from '../utils/logger'
import { CONSTRUCTION_AGENTS } from '../agent/agents'
import type { CustomContext, CustomAgent, CustomAgentStoreData } from './types'

const STORE_PATH = join(app.getPath('userData'), 'custom-agents.json')

const BUILT_IN_NAMES = new Set(CONSTRUCTION_AGENTS.map((a) => a.name))
BUILT_IN_NAMES.add('orchestrator')

function readStore(): CustomAgentStoreData {
  try {
    const data = readFileSync(STORE_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { contexts: [], agents: [] }
  }
}

function writeStore(data: CustomAgentStoreData): void {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    logger.error('Failed to write custom agent store:', err)
  }
}

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export const customAgentStore = {
  // ── Contexts ──

  getContexts(): CustomContext[] {
    return readStore().contexts
  },

  createContext(input: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>): CustomContext {
    const store = readStore()
    const now = new Date().toISOString()
    const ctx: CustomContext = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    }
    store.contexts.push(ctx)
    writeStore(store)
    logger.info(`Custom context created: ${ctx.name} (${ctx.id})`)
    return ctx
  },

  updateContext(id: string, updates: Partial<Omit<CustomContext, 'id' | 'createdAt'>>): CustomContext | null {
    const store = readStore()
    const idx = store.contexts.findIndex((c) => c.id === id)
    if (idx === -1) return null
    store.contexts[idx] = {
      ...store.contexts[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    }
    writeStore(store)
    logger.info(`Custom context updated: ${id}`)
    return store.contexts[idx]
  },

  deleteContext(id: string): boolean {
    const store = readStore()
    const before = store.contexts.length
    store.contexts = store.contexts.filter((c) => c.id !== id)
    if (store.contexts.length === before) return false
    writeStore(store)
    logger.info(`Custom context deleted: ${id}`)
    return true
  },

  // ── Agents ──

  getAgents(): CustomAgent[] {
    return readStore().agents
  },

  createAgent(input: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>): CustomAgent {
    const store = readStore()
    // Ensure unique name that doesn't collide with built-in
    let name = toKebabCase(input.name || input.label)
    if (BUILT_IN_NAMES.has(name) || store.agents.some((a) => a.name === name)) {
      name = `${name}-custom`
    }
    const now = new Date().toISOString()
    const agent: CustomAgent = {
      ...input,
      name,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    }
    store.agents.push(agent)
    writeStore(store)
    logger.info(`Custom agent created: ${agent.label} (${agent.id}, name=${agent.name})`)
    return agent
  },

  updateAgent(id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>): CustomAgent | null {
    const store = readStore()
    const idx = store.agents.findIndex((a) => a.id === id)
    if (idx === -1) return null
    // If name is being updated, validate uniqueness
    if (updates.name) {
      const newName = toKebabCase(updates.name)
      if (BUILT_IN_NAMES.has(newName) || store.agents.some((a, i) => i !== idx && a.name === newName)) {
        updates.name = `${newName}-custom`
      } else {
        updates.name = newName
      }
    }
    store.agents[idx] = {
      ...store.agents[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    }
    writeStore(store)
    logger.info(`Custom agent updated: ${id}`)
    return store.agents[idx]
  },

  deleteAgent(id: string): boolean {
    const store = readStore()
    const before = store.agents.length
    store.agents = store.agents.filter((a) => a.id !== id)
    if (store.agents.length === before) return false
    writeStore(store)
    logger.info(`Custom agent deleted: ${id}`)
    return true
  },
}
