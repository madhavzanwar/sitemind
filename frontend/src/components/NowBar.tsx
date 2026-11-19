import { AlertTriangle, ArrowRight, CheckCircle2, FileCheck2, Hand, Loader2, Play, ShieldAlert, XCircle } from 'lucide-react'
import type { RunSnapshot } from '../types'
import type { Derived } from '../lib/derive'
import { cx, inr } from '../lib/format'
import { RUN_STATUS, TONE } from '../lib/status'
import type { TabId } from './TabsBar'
import { Button, ProgressBar } from './ui'

export function NowBar({ snap, d, onGo, onResume, busy, tab }: { snap: RunSnapshot; d: Derived; onGo: (t: TabId) => void; onResume: () => void; busy: boolean; tab: TabId }) {
  const st = RUN_STATUS[snap.status]
  const killed = snap.status === 'killed'
  const pa = d.pendingApproval
  let icon = <Loader2 className="h-5 w-5 animate-spin text-accent-300" />
  let sentence = d.current ? `Working on: ${d.current.title}` : 'Planning the job'
  let detail: string | null = d.next ? `Next: ${d.next.title}` : null
  let cta: React.ReactNode = null

  if (killed) {
    icon = <ShieldAlert className="h-5 w-5 text-rose-300" />
    sentence = `Worker killed (SIGKILL) at checkpoint #${snap.checkpoints} — progress is frozen, not lost`
    detail = 'LangGraph state is durable and every completed side effect is in the idempotency ledger. Resume to continue from the checkpoint.'
    cta = (
      <Button variant="success" icon={Play} onClick={onResume} disabled={busy} data-testid="now-resume">
        Resume from checkpoint #{snap.checkpoints}
      </Button>
    )
  } else if (snap.status === 'waiting_human' && pa) {
    icon = <Hand className="h-5 w-5 text-violet-300" />
    if (pa.kind === 'po_release') {
      sentence = `Waiting for your approval: release ${pa.po?.po_number ?? 'the PO'} to ${pa.po?.vendor_name ?? 'the vendor'}`
      detail = pa.po ? `${inr(pa.po.total_inr)} incl. GST · delivery ${pa.po.delivery_date}` : pa.summary
    } else {
      sentence = `Waiting for your approval: choose the vendor for ${d.packageTitle}`
      detail = d.recommended ? `The agent recommends ${d.recommended.vendor_name} (${inr(d.recommended.total_inr)}, ${d.recommended.float_days >= 0 ? '+' : ''}${d.recommended.float_days} d float).` : pa.summary
    }
    cta =
      tab === 'approvals' ? null : (
        <Button variant="primary" size="lg" icon={ArrowRight} onClick={() => onGo('approvals')} data-testid="now-approve">
          Review &amp; approve
        </Button>
      )
  } else if (snap.status === 'completed') {
    icon = <CheckCircle2 className="h-5 w-5 text-emerald-400" />
    sentence = snap.po ? `Done: ${snap.po.po_number} sent to ${snap.po.vendor_name}` : 'Run completed'
    detail = snap.po?.issued_at ? `Issued ${Math.max(0, d.daysLeft)} sim days before the ${snap.goal.need_by} need-by date, ${inr(snap.budget.committed_inr)} committed against ${inr(snap.goal.budget_inr)}.` : null
    cta =
      tab === 'po' ? null : (
        <Button variant="secondary" icon={FileCheck2} onClick={() => onGo('po')}>
          View PO
        </Button>
      )
  } else if (snap.status === 'failed') {
    icon = <XCircle className="h-5 w-5 text-rose-400" />
    sentence = 'Run stopped'
    detail = snap.error
  }

  const tone = TONE[st.tone]
  return (
    <section
      data-testid={killed ? 'killed-banner' : 'now-bar'}
      className={cx(
        'card relative overflow-hidden px-5 py-4',
        killed && 'border-rose-500/40 bg-gradient-to-r from-rose-950/70 to-ink-900',
        snap.status === 'waiting_human' && 'border-violet-400/30 bg-gradient-to-r from-violet-950/50 to-ink-900',
      )}
    >
      {killed && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-y-0 w-1/3 animate-scan bg-gradient-to-r from-transparent via-rose-500/10 to-transparent" />
        </div>
      )}
      <div className="relative flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className={cx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', killed ? 'bg-rose-500/20' : snap.status === 'waiting_human' ? 'bg-violet-500/20' : 'bg-white/[0.05]')}>{icon}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span data-testid="run-status" data-status={snap.status} className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', tone.text, tone.bg)}>
                <span className={cx('h-1.5 w-1.5 rounded-full', tone.dot)} />
                {st.label}
              </span>
              <h1 data-testid="now-sentence" className="text-base font-semibold leading-snug text-ink-50">
                {sentence}
              </h1>
            </div>
            {detail && <p className="mt-1 text-sm leading-relaxed text-ink-300">{detail}</p>}
            {d.blockers.length > 0 && !killed && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1" data-testid="blockers">
                {d.blockers.map((b) => (
                  <span key={b} className="inline-flex items-center gap-1.5 text-[13px] text-orange-200">
                    <AlertTriangle className="h-3.5 w-3.5 text-orange-400" />
                    {b}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-5">
          <div className="w-44">
            <div className="flex items-baseline justify-between text-[13px] text-ink-300">
              <span>Progress</span>
              <span className="num text-ink-100">
                {d.done}/{d.total} tasks
              </span>
            </div>
            <ProgressBar className="mt-1.5" value={d.total ? d.done / d.total : 0} frozen={killed} tone={snap.status === 'completed' ? 'success' : 'accent'} />
          </div>
          {cta}
        </div>
      </div>
    </section>
  )
}
