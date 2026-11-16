import { CalendarClock, GitBranch, Trophy, Wallet } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { committedOf, type Derived } from '../lib/derive'
import { cx, fullDate, inr, pct } from '../lib/format'
import { Confidence, Why } from './ui'

function Tile({ icon: Icon, label, value, sub, children, tone }: { icon: typeof Wallet; label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; tone?: string }) {
  return (
    <div className="card flex min-w-0 flex-col px-5 py-4">
      <div className="flex items-center gap-2 text-[13px] text-ink-400">
        <Icon className="h-4 w-4" />
        {label}
        <div className="ml-auto">{children}</div>
      </div>
      <div className={cx('mt-2 truncate text-[22px] font-semibold leading-tight tracking-tight', tone ?? 'text-ink-50')}>{value}</div>
      {sub && <div className="mt-1 truncate text-[13px] text-ink-400">{sub}</div>}
    </div>
  )
}

export function Kpis({ snap, d }: { snap: RunSnapshot; d: Derived }) {
  const b = snap.budget
  const forecast = b.forecast_inr || (d.recommended ? committedOf(d.recommended) : 0)
  const headroom = b.budget_inr - forecast
  const sent = snap.po?.status === 'sent'
  const vendor = d.selected ?? d.recommended
  const replan = [...snap.audit].reverse().find((a) => a.action.includes('replan'))
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" data-testid="kpis">
      <Tile
        icon={CalendarClock}
        label={sent ? 'PO issued' : 'Time to need-by'}
        value={sent ? `${Math.max(0, d.daysLeft)} days early` : `${d.daysLeft} sim days`}
        tone={sent ? 'text-emerald-300' : d.daysLeft < 14 ? 'text-orange-300' : undefined}
        sub={`PO needed by ${fullDate(snap.goal.need_by)}`}
      />
      <Tile
        icon={Wallet}
        label="Budget headroom"
        value={forecast ? <span className="num">{inr(headroom)}</span> : '—'}
        tone={forecast ? (headroom < 0 ? 'text-rose-300' : 'text-emerald-300') : undefined}
        sub={forecast ? `Forecast ${inr(forecast)} of ${inr(b.budget_inr)} (${pct(forecast / b.budget_inr)})` : `Ceiling ${inr(b.budget_inr)}`}
      />
      <Tile
        icon={Trophy}
        label={d.selected ? 'Selected vendor' : 'Recommended vendor'}
        value={vendor ? vendor.vendor_name : snap.quotes.length ? 'Evaluating…' : 'Awaiting quotes'}
        sub={vendor ? `${inr(vendor.total_inr)} · ${vendor.float_days >= 0 ? '+' : ''}${vendor.float_days} d float · ${Math.round(vendor.reliability * 100)}% on time` : `${snap.quotes.length} quotes in`}
      >
        {vendor && (
          <Why testId="why-vendor" align="right">
            <div className="font-semibold text-ink-50">Why {vendor.vendor_name}?</div>
            <p className="mt-1.5 text-ink-200">{vendor.rationale || 'Best weighted score among the feasible options (cost 40 %, schedule float 35 %, reliability 25 %).'}</p>
            <div className="mt-3 flex items-center justify-between text-[13px] text-ink-400">
              <span>Score {vendor.score.toFixed(2)} · budget {vendor.budget_verdict}</span>
              <Confidence value={Math.min(0.99, 0.6 + vendor.score / 2)} />
            </div>
          </Why>
        )}
      </Tile>
      <Tile
        icon={GitBranch}
        label="Plan"
        value={`Version ${snap.plan?.version ?? 0}`}
        sub={d.superseded ? `${d.superseded} task${d.superseded > 1 ? 's' : ''} superseded by re-planning` : 'Original plan'}
      >
        {replan && (
          <Why testId="why-replan" align="right">
            <div className="font-semibold text-ink-50">Why did the agent re-plan?</div>
            <p className="mt-1.5 text-ink-200">{replan.summary}</p>
            <div className="mt-3 flex items-center justify-between text-[13px] text-ink-400">
              <span>Planner · plan v{replan.plan_version ?? '?'}</span>
              <Confidence value={replan.confidence} />
            </div>
          </Why>
        )}
      </Tile>
    </div>
  )
}
