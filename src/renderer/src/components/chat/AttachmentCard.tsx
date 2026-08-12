import { FileText, FileSpreadsheet, Image as ImageIcon, File as FileIcon, X } from 'lucide-react'
import { formatFileSize, isImageAttachment, toFileUrl, type AttachmentFile } from '@/hooks/useAttachments'

interface AttachmentCardProps {
  attachment: AttachmentFile
  onRemove: (path: string) => void
}

const DOC_EXTENSIONS = new Set(['pdf', 'docx', 'txt'])
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv'])

function iconFor(ext: string) {
  const e = (ext || '').toLowerCase()
  if (isImageAttachment(e)) return ImageIcon
  if (SHEET_EXTENSIONS.has(e)) return FileSpreadsheet
  if (DOC_EXTENSIONS.has(e)) return FileText
  return FileIcon // dwg y cualquier otro tipo soportado sin ícono dedicado
}

/** Tarjeta de adjunto (Ola 1) — se muestra en la fila encima de la barra de input,
 *  una por archivo. Miniatura de imagen para tipos gráficos, ícono por tipo para el resto. */
export function AttachmentCard({ attachment, onRemove }: AttachmentCardProps) {
  const Icon = iconFor(attachment.ext)
  const isImage = isImageAttachment(attachment.ext)

  return (
    <div className="group relative flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs max-w-[220px]">
      {isImage ? (
        <img
          src={toFileUrl(attachment.path)}
          alt={attachment.name}
          className="size-7 rounded object-cover shrink-0 border border-slate-200 bg-white"
          onError={(e) => {
            // Si la miniatura no carga (permisos, formato raro), no dejamos un ícono roto.
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <Icon className="size-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
      )}
      <span className="flex flex-col min-w-0">
        <span className="font-medium text-slate-700 truncate" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-slate-400">{formatFileSize(attachment.sizeBytes)}</span>
      </span>
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        aria-label={`Quitar ${attachment.name}`}
        title="Quitar adjunto"
        className="ml-auto shrink-0 p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
      >
        <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  )
}
