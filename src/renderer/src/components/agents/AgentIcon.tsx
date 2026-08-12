import type { LucideIcon } from 'lucide-react'

/**
 * Los agentes built-in (agentConfig.ts) usan un ícono lucide-react (consistente
 * con el resto de la UI, Ola 2). Los agentes/contextos CUSTOM los crea el usuario
 * eligiendo un emoji libre en CustomAgentModal/ContextModal — esos siguen siendo
 * string y se renderizan tal cual.
 */
export type AgentIconType = LucideIcon | string

interface AgentIconGlyphProps {
  icon: AgentIconType
  className?: string
}

export function AgentIconGlyph({ icon, className }: AgentIconGlyphProps) {
  if (typeof icon === 'string') {
    return <span className={className}>{icon}</span>
  }
  const Icon = icon
  return <Icon className={className} strokeWidth={2} aria-hidden="true" />
}
