import { useToast, type ToastType } from '@/hooks/useToast'

const icons: Record<ToastType, string> = {
  success: 'M5 13l4 4L19 7',
  error: 'M6 18L18 6M6 6l12 12',
  warning: 'M12 9v4m0 4h.01M12 3l9.5 16.5H2.5L12 3z',
  info: 'M13 16h-1v-4h-1m1-4h.01',
}

const colors: Record<ToastType, { bg: string; border: string; text: string; icon: string }> = {
  success: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-800', icon: 'text-emerald-500' },
  error: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800', icon: 'text-red-500' },
  warning: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-800', icon: 'text-amber-500' },
  info: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-800', icon: 'text-blue-500' },
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const c = colors[toast.type]
        return (
          <div
            key={toast.id}
            className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border shadow-lg ${c.bg} ${c.border} animate-slide-in`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`${c.icon} mt-0.5 shrink-0`}
            >
              <path d={icons[toast.type]} />
            </svg>
            <p className={`text-xs leading-relaxed flex-1 ${c.text}`}>{toast.message}</p>
            <button
              onClick={() => removeToast(toast.id)}
              className={`${c.icon} hover:opacity-70 shrink-0 mt-0.5`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
