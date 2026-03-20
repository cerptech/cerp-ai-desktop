interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className = '', children, ...props }: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-brand-orange/50 disabled:opacity-50 disabled:cursor-not-allowed'

  const variants = {
    primary: 'bg-brand-orange text-white hover:bg-brand-orange/90',
    secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200',
    ghost: 'text-slate-600 hover:bg-slate-100',
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  )
}
