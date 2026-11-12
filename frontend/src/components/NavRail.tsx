import { FileCheck2, Inbox, LayoutDashboard, Plus, ScrollText } from 'lucide-react'
import { cx } from '../lib/format'

export type TabId = 'overview' | 'approvals' | 'audit' | 'po'

const TABS: { id: TabId; label: string; icon: typeof Inbox }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'approvals', label: 'Approvals', icon: Inbox },
  { id: 'audit', label: 'Audit', icon: ScrollText },
  { id: 'po', label: 'PO', icon: FileCheck2 },
]

export function NavRail({
  tab,
  onTab,
  pending,
  poReady,
  onNew,
}: {
  tab: TabId
  onTab: (t: TabId) => void
  pending: number
  poReady: boolean
  onNew: () => void
}) {
  return (
    <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 border-r border-white/[0.05] bg-ink-950/50 py-4" role="tablist" aria-orientation="vertical">
      {TABS.map((t) => {
        const active = tab === t.id
        const badge = t.id === 'approvals' ? pending : 0
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            data-testid={`tab-${t.id}`}
            onClick={() => onTab(t.id)}
            className={cx(
              'group relative flex w-[60px] flex-col items-center gap-1 rounded-xl py-2.5 text-[10.5px] font-medium transition-all',
              active ? 'bg-accent-400/10 text-accent-300' : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-100',
            )}
          >
            {active && <span className="absolute -left-2 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-accent-400" />}
            <t.icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
            {t.label}
            {badge > 0 && (
              <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 animate-pulse place-items-center rounded-full bg-violet-500 px-1 text-[9.5px] font-bold text-white shadow-[0_0_12px_rgba(139,92,246,0.7)]">
                {badge}
              </span>
            )}
            {t.id === 'po' && poReady && <span className="absolute right-2.5 top-2 h-2 w-2 rounded-full bg-emerald-400" />}
          </button>
        )
      })}
      <div className="flex-1" />
      <button
        onClick={onNew}
        data-testid="new-run"
        className="flex w-[60px] flex-col items-center gap-1 rounded-xl py-2.5 text-[10.5px] font-medium text-ink-400 transition hover:bg-white/[0.04] hover:text-ink-100"
      >
        <Plus className="h-5 w-5" strokeWidth={1.75} />
        New run
      </button>
    </nav>
  )
}
