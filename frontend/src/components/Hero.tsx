import { CalendarClock, GitBranch, Loader2, Target, Workflow } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { cx, daysBetween, fullDate, inr } from '../lib/format'
import { RUN_STATUS, TONE } from '../lib/status'
import { Label, ProgressBar } from './ui'

export function Hero({ snap }: { snap: RunSnapshot }) {
  const tasks = snap.plan?.tasks.filter((t) => t.status !== 'skipped') ?? []
  const done = tasks.filter((t) => t.status === 'done').length
  const st = RUN_STATUS[snap.status]
  const tone = TONE[st.tone]
  const killed = snap.status === 'killed'
  const daysLeft = daysBetween(snap.sim_now, snap.goal.need_by)
  const sent = snap.po?.status === 'sent'
  const superseded = (snap.plan?.tasks.length ?? 0) - tasks.length

  return (
    <section className={cx('card relative overflow-hidden px-6 py-5', killed && 'border-rose-500/25')}>
      <div
        className={cx(
          'pointer-events-none absolute inset-y-0 left-0 w-1',
          killed ? 'bg-rose-500' : snap.status === 'completed' ? 'bg-emerald-400' : snap.status === 'waiting_human' ? 'bg-violet-400' : 'bg-accent-400',
        )}
      />
      <div className="flex items-center gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5 text-accent-400" />
            <Label>Goal · {snap.goal.project} · {snap.goal.package}</Label>
            <span className="num ml-1 text-[11px] text-ink-500">{snap.run_id}</span>
          </div>
          <h1 className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-tight text-ink-50" title={snap.goal.text}>
            {snap.goal.text}
          </h1>
          <div className="mt-3 flex items-center gap-3">
            <span
              data-testid="run-status"
              data-status={snap.status}
              className={cx('inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ring-inset', tone.text, tone.bg, tone.ring)}
            >
              {snap.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <span className={cx('h-2 w-2 rounded-full', tone.dot, snap.status === 'waiting_human' && 'animate-pulse')} />
              )}
              {st.label}
            </span>
            <ProgressBar value={tasks.length ? done / tasks.length : 0} frozen={killed} tone={snap.status === 'completed' ? 'success' : 'accent'} className="w-72" />
            <span className="num text-[12.5px] text-ink-300">
              <span className="font-semibold text-ink-50">{done}</span>/{tasks.length} tasks
            </span>
            {snap.error && <span className="truncate text-[12px] text-rose-300">{snap.error}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-stretch divide-x divide-white/[0.06]">
          <Stat icon={CalendarClock} label={sent ? 'PO issued' : 'Need-by countdown'}>
            {sent ? (
              <>
                <span className="text-emerald-300">{Math.max(0, daysLeft)} d early</span>
              </>
            ) : (
              <span className={daysLeft < 14 ? 'text-orange-300' : 'text-ink-50'}>
                {daysLeft} <span className="text-[13px] font-medium text-ink-400">sim days</span>
              </span>
            )}
            <Sub>PO by {fullDate(snap.goal.need_by)}</Sub>
          </Stat>
          <Stat icon={Target} label="Budget ceiling">
            <span className="text-ink-50">{inr(snap.goal.budget_inr)}</span>
            <Sub>On site {snap.goal.required_on_site ? fullDate(snap.goal.required_on_site) : '—'}</Sub>
          </Stat>
          <Stat icon={Workflow} label="Current node">
            <span className={cx('font-mono text-[18px]', killed ? 'text-rose-300 line-through decoration-rose-500/60' : 'text-accent-300')}>
              {snap.current_node ?? (snap.status === 'completed' ? 'END' : '—')}
            </span>
            <Sub>checkpoint #{snap.checkpoints}</Sub>
          </Stat>
          <Stat icon={GitBranch} label="Plan">
            <span className="flex items-center gap-2">
              <span data-testid="plan-version" className="rounded-md bg-accent-400/15 px-2 py-0.5 font-mono text-[17px] text-accent-300 ring-1 ring-inset ring-accent-400/30">
                v{snap.plan?.version ?? 0}
              </span>
            </span>
            <Sub>{superseded ? `${superseded} superseded` : 'original plan'}</Sub>
          </Stat>
        </div>
      </div>
    </section>
  )
}

function Stat({ icon: Icon, label, children }: { icon: typeof Target; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-[168px] flex-col px-6 first:pl-0 last:pr-0">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-ink-400" />
        <Label>{label}</Label>
      </div>
      <div className="num mt-1.5 text-[22px] font-semibold leading-none tracking-tight">{children}</div>
    </div>
  )
}

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-1.5 font-sans text-[11.5px] font-normal tracking-normal text-ink-400">{children}</div>
}
