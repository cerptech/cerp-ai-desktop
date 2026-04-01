import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import type { CustomContext } from '../../../../preload/index'

interface ContextModalProps {
  context?: CustomContext | null
  onSave: (data: Omit<CustomContext, 'id' | 'createdAt' | 'updatedAt'>) => void
  onDelete?: () => void
  onClose: () => void
}

export function ContextModal({ context, onSave, onDelete, onClose }: ContextModalProps) {
  const [name, setName] = useState(context?.name || '')
  const [icon, setIcon] = useState(context?.icon || '')
  const [instructions, setInstructions] = useState(context?.instructions || '')

  const isEdit = !!context

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !instructions.trim()) return
    onSave({
      name: name.trim(),
      icon: icon.trim() || '\u{1F4DD}',
      instructions: instructions.trim(),
    })
  }

  return (
    <Modal title={isEdit ? 'Editar contexto' : 'Nuevo contexto'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name + Icon row */}
        <div className="flex gap-3">
          <div className="w-20">
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Icono</label>
            <input
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder=""
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-lg focus:outline-none focus:ring-2 focus:ring-purple-300/50 focus:border-purple-300"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Normativa Espanola"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300/50 focus:border-purple-300"
              required
            />
          </div>
        </div>

        {/* Instructions */}
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">Instrucciones</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Instrucciones adicionales que se inyectan al asistente cuando este contexto esta activo..."
            rows={8}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-purple-300/50 focus:border-purple-300"
            required
          />
          <p className="text-[10px] text-slate-400 mt-1">
            Estas instrucciones se agregan al prompt del orquestador cuando activas este contexto.
            No crean un agente nuevo, sino que modifican el comportamiento general.
          </p>
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
                Eliminar contexto
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
              disabled={!name.trim() || !instructions.trim()}
              className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-purple-500 hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEdit ? 'Guardar cambios' : 'Crear contexto'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
