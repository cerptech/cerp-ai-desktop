interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  const sizes = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  }

  return (
    <div
      className={`${sizes[size]} animate-spin rounded-full border-2 border-slate-200 border-t-brand-orange ${className}`}
      role="status"
    >
      <span className="sr-only">Cargando...</span>
    </div>
  )
}
