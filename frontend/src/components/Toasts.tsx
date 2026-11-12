import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { cx } from '../lib/format'

export interface Toast {
  id: number
  tone: 'success' | 'danger' | 'info'
  title: string
  body?: string
}

export function Toasts({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[380px] flex-col gap-3">
      {toasts.map((t) => {
        const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'danger' ? AlertTriangle : Info
        return (
          <div
            key={t.id}
            data-testid="toast"
            className={cx(
              'pointer-events-auto flex animate-slide-in gap-3 rounded-xl border bg-ink-850/95 p-4 shadow-2xl backdrop-blur-xl',
              t.tone === 'success' && 'border-emerald-400/30',
              t.tone === 'danger' && 'border-rose-500/40',
              t.tone === 'info' && 'border-white/10',
            )}
          >
            <Icon
              className={cx('mt-0.5 h-5 w-5 shrink-0', t.tone === 'success' ? 'text-emerald-400' : t.tone === 'danger' ? 'text-rose-400' : 'text-sky-300')}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-ink-50">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-300">{t.body}</div>}
            </div>
            <button onClick={() => onClose(t.id)} className="h-6 w-6 shrink-0 rounded text-ink-400 hover:text-ink-100" aria-label="Dismiss">
              <X className="mx-auto h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
