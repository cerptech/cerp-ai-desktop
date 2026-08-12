import { useCallback, useState } from 'react'
import { useToast } from './useToast'
import type { AttachmentFile } from '../../../preload/index'

export type { AttachmentFile }

/**
 * useAttachments — adjuntos multi-archivo del composer (Ola 1).
 *
 * Reemplaza al viejo `attachedPdf` (un solo PDF, ruta pegada como texto en el
 * prompt). Los archivos llegan ya resueltos a `{ path, name, ext, sizeBytes }`
 * — vía el diálogo nativo (`window.cerpAPI.selectAttachments`) o drag&drop
 * (`window.cerpAPI.getPathForFile`) — y esta hook solo valida y mantiene la lista.
 * El agente los lee del disco directamente: no hay ninguna subida acá.
 */

export const ALLOWED_ATTACHMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'xlsx', 'xls', 'csv', 'docx', 'txt', 'dwg']
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS = 5

export function useAttachments() {
  const [attachments, setAttachments] = useState<AttachmentFile[]>([])
  const { addToast } = useToast()

  const addFiles = useCallback((files: AttachmentFile[]) => {
    if (files.length === 0) return

    setAttachments((prev) => {
      const next = [...prev]
      let hitLimit = false

      for (const file of files) {
        if (next.length >= MAX_ATTACHMENTS) {
          hitLimit = true
          break
        }
        if (next.some((a) => a.path === file.path)) continue // ya adjuntado

        const ext = (file.ext || '').toLowerCase()
        if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
          addToast('error', `Tipo de archivo no soportado: ${file.name}`)
          continue
        }
        if (file.sizeBytes > MAX_ATTACHMENT_BYTES) {
          addToast('error', `${file.name} supera el tamaño máximo de 25 MB`)
          continue
        }
        next.push(file)
      }

      if (hitLimit) {
        addToast('error', `Máximo ${MAX_ATTACHMENTS} archivos adjuntos por mensaje`)
      }
      return next
    })
  }, [addToast])

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }, [])

  const clearAttachments = useCallback(() => setAttachments([]), [])

  return { attachments, addFiles, removeAttachment, clearAttachments }
}

/** Icono/tamaño legible — helpers compartidos por AttachmentCard. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export function isImageAttachment(ext: string): boolean {
  return IMAGE_EXTENSIONS.has((ext || '').toLowerCase())
}

/** file:// URL para thumbnails de imagen — normaliza backslashes de Windows.
 *  Usa encodeURI (no encodeURIComponent) para no escapar ':' — necesario para
 *  que la letra de unidad de Windows ("C:") quede literal en la URL. */
export function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash)}`
}
