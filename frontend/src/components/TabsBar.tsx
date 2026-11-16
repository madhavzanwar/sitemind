import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { cx } from '../lib/format'

export type TabId = 'overview' | 'plan' | 'vendors' | 'approvals' | 'audit' | 'po'

export const TAB_IDS: TabId[] = ['overview', 'plan', 'vendors', 'approvals', 'audit', 'po']

const LABEL: Record<TabId, string> = {
  overview: 'Overview',
  plan: 'Plan',
  vendors: 'Vendors',
  approvals: 'Approvals',
  audit: 'Audit',
  po: 'PO',
}

export interface Toast {
  id: number
  tone: 'success' | 'danger' | 'info'
  title: string
  body?: string
}

export function TabsBar({
  tab,
  onTab,
  counts,
  toast,
  onDismiss,
  llm,
}: {
  tab: TabId
  onTab: (t: TabId) => void
  counts: Partial<Record<TabId, { n: number; urgent?: boolean }>>
  toast: Toast | null
  onDismiss: () => void
  llm: string
}) {
  return (
    <div className="flex h-12 shrink-0 items-stretch gap-4 border-b border-white/[0.06] bg-ink-950 px-4 lg:px-6">
      <nav className="-mb-px flex min-w-0 items-stretch gap-1 overflow-x-auto" role="tablist">
        {TAB_IDS.map((id) => {
          const active = tab === id
          const c = counts[id]
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              data-testid={`tab-${id}`}
              onClick={() => onTab(id)}
              className={cx(
                'relative flex shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
                active ? 'border-accent-400 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100',
              )}
            >
              {LABEL[id]}
              {c && c.n > 0 && (
                <span
                  className={cx(
                    'num grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-semibold',
                    c.urgent ? 'bg-violet-500 text-white' : 'bg-white/[0.08] text-ink-200',
                  )}
                >
                  {c.n}
                </span>
              )}
            </button>
          )
        })}
      </nav>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {toast ? (
          <div
            key={toast.id}
            data-testid="toast"
            role="status"
            className={cx(
              'flex min-w-0 max-w-[560px] animate-fade-up items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-1.5 text-sm',
              toast.tone === 'success' && 'bg-emerald-400/10 text-emerald-100',
              toast.tone === 'danger' && 'bg-rose-500/15 text-rose-100',
              toast.tone === 'info' && 'bg-white/[0.06] text-ink-100',
            )}
          >
            {toast.tone === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : toast.tone === 'danger' ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            ) : (
              <Info className="h-4 w-4 shrink-0 text-sky-300" />
            )}
            <span className="shrink-0 font-semibold">{toast.title}</span>
            {toast.body && <span className="truncate text-ink-300">{toast.body}</span>}
            <button onClick={onDismiss} className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-400 hover:text-ink-50" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span data-testid="llm-badge" className="hidden truncate text-[13px] text-ink-500 lg:inline">
            {llm}
          </span>
        )}
      </div>
    </div>
  )
}
