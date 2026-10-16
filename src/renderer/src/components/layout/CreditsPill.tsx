import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

export const SUBSCRIPTION_URL = 'https://app.cerp.es/settings/subscription'

type Tone = 'neutral' | 'warning' | 'danger' | 'loading'

interface CreditsPillProps {
  label: string
  tone?: Tone
  title?: string
  /** Click en el texto (p. ej. reintentar tras un error de red). */
  onClick?: () => void
  /** Segmento de la derecha. `null` lo oculta (Ilimitado: no hay nada que mejorar). */
  action?: { label: string; href: string } | null
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-[#3f3f46]',
  warning: 'text-amber-700',
  danger: 'text-red-700',
  loading: 'text-slate-400',
}

/**
 * Píldora de créditos de la cabecera: el estado real a la izquierda y
 * «Mejorar plan» a la derecha (abre la suscripción en el navegador).
 */
export function CreditsPill({ label, tone = 'neutral', title, onClick, action = { label: 'Mejorar plan', href: SUBSCRIPTION_URL } }: CreditsPillProps) {
  const text = (
    <>
      {tone === 'loading' && <LoadingSpinner size="sm" />}
      {label}
    </>
  )
  return (
    <div className="inline-flex h-[30px] shrink-0 items-stretch overflow-hidden rounded-full border border-composer-border bg-white text-xs" title={title}>
      {onClick ? (
        <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 px-2.5 hover:bg-black/5 transition-colors ${TONE_CLASS[tone]}`}>
          {text}
        </button>
      ) : (
        <span className={`inline-flex items-center gap-1.5 px-2.5 ${TONE_CLASS[tone]}`}>{text}</span>
      )}
      {action && (
        <a
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center px-2.5 bg-primary-50 font-semibold text-primary-800 hover:bg-primary-100 transition-colors"
        >
          {action.label}
        </a>
      )}
    </div>
  )
}
