import type { ComponentType, ReactNode } from 'react'
import type { LucideProps } from 'lucide-react'
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
    <section data-testid={testId} className={cx('card flex min-h-0 min-w-0 flex-col', className)}>
      {title && (
        <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.05] px-4">
          {IconC && <IconC className="h-4 w-4 text-ink-300" strokeWidth={1.75} />}
          <h2 className="text-[13px] font-semibold tracking-tight text-ink-100">{title}</h2>
          {subtitle && <span className="truncate text-xs text-ink-400">{subtitle}</span>}
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
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        t.text,
        t.bg,
        t.ring,
        className,
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', t.dot)} />}
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-ink-300">{children}</span>
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400', className)}>{children}</div>
}

export function Empty({ icon: IconC, title, hint, className }: { icon: Icon; title: string; hint?: string; className?: string }) {
  return (
    <div className={cx('flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-6 text-center', className)}>
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.03] ring-1 ring-white/[0.06]">
        <IconC className="h-5 w-5 text-ink-400" strokeWidth={1.5} />
      </div>
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {hint && <div className="max-w-xs text-xs text-ink-400">{hint}</div>}
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
    primary: 'bg-accent-400 text-ink-950 hover:bg-accent-300 shadow-[0_0_0_1px_rgba(255,178,36,0.5),0_8px_24px_-8px_rgba(255,178,36,0.55)]',
    secondary: 'bg-white/[0.05] text-ink-100 ring-1 ring-inset ring-white/10 hover:bg-white/[0.08]',
    danger: 'bg-rose-600 text-white hover:bg-rose-500 shadow-[0_0_0_1px_rgba(244,63,94,0.6),0_8px_24px_-8px_rgba(244,63,94,0.6)]',
    success: 'bg-emerald-500 text-ink-950 hover:bg-emerald-400 shadow-[0_0_0_1px_rgba(52,211,153,0.5),0_8px_24px_-8px_rgba(52,211,153,0.5)]',
    ghost: 'text-ink-300 hover:bg-white/[0.05] hover:text-ink-100',
  }[variant]
  const s = { sm: 'h-7 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-[13px] gap-2', lg: 'h-11 px-5 text-sm gap-2' }[size]
  return (
    <button
      className={cx(
        'inline-flex select-none items-center justify-center rounded-lg font-semibold transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40',
        v,
        s,
        className,
      )}
      {...rest}
    >
      {IconC && <IconC className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={2} />}
      {children}
    </button>
  )
}

export function ProgressBar({ value, tone = 'accent', frozen, className }: { value: number; tone?: Tone; frozen?: boolean; className?: string }) {
  return (
    <div className={cx('relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]', className)}>
      <div
        className={cx('absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out', frozen ? 'bg-rose-500/70 striped' : TONE[tone].dot)}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  )
}
