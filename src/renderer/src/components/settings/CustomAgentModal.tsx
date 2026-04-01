import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import type { CustomAgent } from '../../../../preload/index'

const AVAILABLE_TOOLS = [
  { value: 'Bash', label: 'Terminal (Bash)' },
  { value: 'Read', label: 'Leer archivos' },
  { value: 'Write', label: 'Escribir archivos' },
  { value: 'Edit', label: 'Editar archivos' },
  { value: 'Glob', label: 'Buscar archivos' },
  { value: 'Grep', label: 'Buscar en contenido' },
  { value: 'mcp__cerp__*', label: 'Herramientas CERP (todas)' },
]

const DEFAULT_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']

interface CustomAgentModalProps {
  agent?: CustomAgent | null
  onSave: (data: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => void
  onDelete?: () => void
  onClose: () => void
}

export function CustomAgentModal({ agent, onSave, onDelete, onClose }: CustomAgentModalProps) {
  const [label, setLabel] = useState(agent?.label || '')
  const [icon, setIcon] = useState(agent?.icon || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [allowedTools, setAllowedTools] = useState<string[]>(agent?.allowedTools || DEFAULT_TOOLS)

  const isEdit = !!agent

  const handleToggleTool = (tool: string) => {
    setAllowedTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim() || !systemPrompt.trim()) return
    onSave({
      name: agent?.name || label.trim(),
      label: label.trim(),
      icon: icon.trim() || '\u{1F916}',
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      allowedTools,
    })
  }

  return (
    <Modal title={isEdit ? 'Editar agente' : 'Nuevo agente'} onClose={onClose} width="max-w-xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Label + Icon row */}
        <div className="flex gap-3">
          <div className="w-20">
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Icono</label>
            <input
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder=""
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Nombre</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ej: Experto en Seguridad"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
              required
            />
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">Descripcion</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Breve descripcion de lo que hace este agente"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
          />
        </div>

        {/* System Prompt */}
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">Instrucciones del agente</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Eres un especialista en..."
            rows={8}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange/50"
            required
          />
          <p className="text-[10px] text-slate-400 mt-1">
            Define el comportamiento, conocimientos y reglas del agente.
          </p>
        </div>

        {/* Allowed Tools */}
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-2">Herramientas permitidas</label>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_TOOLS.map((tool) => (
              <button
                key={tool.value}
                type="button"
                onClick={() => handleToggleTool(tool.value)}
                className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                  allowedTools.includes(tool.value)
                    ? 'border-brand-orange/30 bg-orange-50 text-brand-orange'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300'
                }`}
              >
                {tool.label}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100">
          <div>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="text-xs text-red-500 hover:text-red-700 transition-colors"
              >
                Eliminar agente
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!label.trim() || !systemPrompt.trim()}
              className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-brand-orange hover:bg-brand-orange/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEdit ? 'Guardar cambios' : 'Crear agente'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
