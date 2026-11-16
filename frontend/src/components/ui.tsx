import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { HelpCircle, X, type LucideProps } from 'lucide-react'
import { cx } from '../lib/format'
import { TONE, type Tone } from '../lib/status'

type Icon = ComponentType<LucideProps>

export function Card({
  title,
  icon: IconC,
  right,
  children,
  className,
  bodyClassName,
  testId,
  subtitle,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  icon?: Icon
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  testId?: string
}) {
  return (
    <section data-testid={testId} className={cx('card flex min-w-0 flex-col', className)}>
      {title && (
        <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-3.5">
          {IconC && <IconC className="h-[18px] w-[18px] text-ink-300" strokeWidth={1.75} />}
          <h2 className="text-[15px] font-semibold tracking-tight text-ink-50">{title}</h2>
          {subtitle && <span className="text-sm text-ink-400">{subtitle}</span>}
          <div className="ml-auto flex items-center gap-2">{right}</div>
        </header>
      )}
      <div className={cx('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
  testId,
  title,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
  dot?: boolean
  testId?: string
  title?: string
}) {
  const t = TONE[tone]
  return (
    <span
      data-testid={testId}
      title={title}
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', t.text, t.bg, className)}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', t.dot)} />}
      {children}
    </span>
  )
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-xs font-medium text-ink-400', className)}>{children}</div>
}

export function Empty({ icon: IconC, title, hint, className, children }: { icon: Icon; title: string; hint?: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cx('flex h-full min-h-[140px] flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.04]">
        <IconC className="h-5 w-5 text-ink-300" strokeWidth={1.6} />
      </div>
      <div className="text-[15px] font-medium text-ink-100">{title}</div>
      {hint && <div className="max-w-sm text-sm leading-relaxed text-ink-400">{hint}</div>}
      {children}
    </div>
  )
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  icon: IconC,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
  size?: 'sm' | 'md' | 'lg'
  icon?: Icon
}) {
  const v = {
    primary: 'bg-accent-400 text-ink-950 hover:bg-accent-300',
    secondary: 'bg-white/[0.06] text-ink-50 hover:bg-white/[0.1]',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
    success: 'bg-emerald-500 text-ink-950 hover:bg-emerald-400',
    ghost: 'text-ink-200 hover:bg-white/[0.06] hover:text-ink-50',
  }[variant]
  const s = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-[15px] gap-2' }[size]
  return (
    <button
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
        v,
        s,
        className,
      )}
      {...rest}
    >
      {IconC && <IconC className={size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={2} />}
      {children}
    </button>
  )
}

export function ProgressBar({ value, tone = 'accent', frozen, className }: { value: number; tone?: Tone; frozen?: boolean; className?: string }) {
  return (
    <div className={cx('relative h-2 overflow-hidden rounded-full bg-white/[0.07]', className)}>
      <div
        className={cx('absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out', frozen ? 'striped bg-rose-500/80' : TONE[tone].dot)}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  )
}

/** Right-side detail drawer (overlay). */
export function Drawer({ open, onClose, title, subtitle, children, testId }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; testId?: string }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 animate-fade-in bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose} />
      <aside data-testid={testId} className="relative flex h-full w-full max-w-[520px] animate-slide-in flex-col border-l border-white/[0.08] bg-ink-900 shadow-2xl">
        <header className="flex items-start gap-3 border-b border-white/[0.06] px-6 py-5">
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold leading-snug text-ink-50">{title}</div>
            {subtitle && <div className="mt-1 text-sm text-ink-400">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-ink-300 hover:bg-white/[0.06] hover:text-ink-50" aria-label="Close drawer">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>
  )
}

/** "Why?" affordance: a small button that opens an explanation popover. */
export function Why({ children, label = 'Why?', className, testId, align = 'left' }: { children: ReactNode; label?: string; className?: string; testId?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('mousedown', h)
      window.removeEventListener('keydown', k)
    }
  }, [open])
  return (
    <span ref={ref} className={cx('relative inline-flex', className)}>
      <button
        type="button"
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-accent-300 hover:bg-accent-400/10"
        aria-expanded={open}
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {label}
      </button>
      {open && (
        <div
          className={cx(
            'absolute top-full z-30 mt-2 w-[360px] max-w-[80vw] animate-fade-up rounded-xl border border-white/10 bg-ink-800 p-4 text-left text-sm leading-relaxed text-ink-100 shadow-2xl',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </span>
  )
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-ink-500">—</span>
  const tone = value >= 0.9 ? 'bg-emerald-400' : value >= 0.75 ? 'bg-accent-400' : 'bg-orange-400'
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.08]">
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${value * 100}%` }} />
      </span>
      <span className="num text-[13px] text-ink-200">{Math.round(value * 100)}%</span>
    </span>
  )
}

export function Kv({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <Label>{label}</Label>
      <div className="mt-1 text-sm text-ink-50">{children}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  testIdPrefix?: string
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/[0.05] p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          data-testid={testIdPrefix ? `${testIdPrefix}${o.value}` : undefined}
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', value === o.value ? 'bg-ink-600 text-ink-50 shadow-sm' : 'text-ink-300 hover:text-ink-50')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
