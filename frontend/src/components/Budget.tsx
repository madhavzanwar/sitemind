import { Wallet } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { cx, inr, parseTime, pct } from '../lib/format'
import { Card, Why } from './ui'

const C_FORECAST = '#FFB224'
const C_COMMITTED = '#2DD4BF'

export function Budget({ snap, className }: { snap: RunSnapshot; className?: string }) {
  const b = snap.budget
  const forecast = b.forecast_inr
  const headroom = b.budget_inr - forecast
  const scale = Math.max(b.budget_inr, forecast, b.committed_inr) * 1.08 || 1
  const util = b.budget_inr ? forecast / b.budget_inr : 0
  const verdict = util > 1 ? 'Over budget' : util >= 0.9 ? 'Tight' : 'Within budget'
  const vTone = util > 1 ? 'text-rose-300' : util >= 0.9 ? 'text-orange-300' : 'text-emerald-300'
  const last = [...snap.audit].reverse().find((a) => a.actor === 'budget')
  return (
    <Card
      testId="budget-chart"
      title="Budget"
      icon={Wallet}
      className={className}
      bodyClassName="px-5 pb-5"
      right={
        last && (
          <Why align="right" testId="why-budget">
            <div className="font-semibold text-ink-50">How the forecast is built</div>
            <p className="mt-1.5 text-ink-200">Forecast = best feasible option's quote (ex-GST) + 5 % contingency + any expedite fee. Committed = money actually committed by a sent PO.</p>
            <p className="mt-2 text-ink-300">Latest check: {last.summary}</p>
          </Why>
        )
      }
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[13px] text-ink-400">Headroom</div>
          <div className={cx('num mt-1 text-[28px] font-semibold leading-none', forecast ? (headroom < 0 ? 'text-rose-300' : 'text-emerald-300') : 'text-ink-300')}>{forecast ? inr(headroom) : '—'}</div>
        </div>
        <div className="text-right">
          <div className={cx('text-sm font-medium', forecast ? vTone : 'text-ink-400')}>{forecast ? verdict : 'No quotes yet'}</div>
          <div className="num mt-1 text-[13px] text-ink-400">{forecast ? `${pct(util)} of ceiling` : ''}</div>
        </div>
      </div>

      <div className="mt-5 space-y-3.5">
        <Bar label="Ceiling" value={b.budget_inr} scale={scale} color="rgba(221,227,236,0.25)" ceiling={b.budget_inr} />
        <Bar label="Forecast" value={forecast} scale={scale} color={util > 1 ? '#F43F5E' : C_FORECAST} ceiling={b.budget_inr} />
        <Bar label="Committed" value={b.committed_inr} scale={scale} color={C_COMMITTED} ceiling={b.budget_inr} />
      </div>

      <Spark snap={snap} />
      <div className="mt-3 text-[13px] text-ink-400">
        Agent process cost so far <span className="num text-ink-200">{inr(b.spent_process_inr)}</span>
      </div>
    </Card>
  )
}

function Bar({ label, value, scale, color, ceiling }: { label: string; value: number; scale: number; color: string; ceiling: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-ink-300">{label}</span>
        <span className="num text-ink-50">{value ? inr(value) : '—'}</span>
      </div>
      <div className="relative mt-1.5 h-2.5 rounded-full bg-white/[0.06]">
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700" style={{ width: `${(value / scale) * 100}%`, background: color }} />
        <div className="absolute -inset-y-1 w-0.5 rounded bg-ink-100/70" style={{ left: `${(ceiling / scale) * 100}%` }} title="Budget ceiling" />
      </div>
    </div>
  )
}

/** Tiny forecast history (no axes): how the forecast moved against the ceiling. */
function Spark({ snap }: { snap: RunSnapshot }) {
  const pts = snap.budget.points.filter((p) => p.forecast_inr > 0)
  if (pts.length < 2) return null
  const W = 300
  const H = 52
  const t0 = parseTime(snap.sim_start)
  const t1 = Math.max(parseTime(snap.sim_now), ...pts.map((p) => parseTime(p.sim_time)))
  const vals = [snap.budget.budget_inr, ...pts.map((p) => p.forecast_inr)]
  const lo = Math.min(...vals) * 0.96
  const hi = Math.max(...vals) * 1.02
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * H
  let d = `M0,${y(pts[0]!.forecast_inr)}`
  pts.forEach((p, i) => {
    if (i) d += ` H${x(parseTime(p.sim_time))}`
    d += ` V${y(p.forecast_inr)}`
  })
  d += ` H${W}`
  return (
    <div className="mt-5">
      <div className="text-[13px] text-ink-400">Forecast over time</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-[52px] w-full overflow-visible">
        <line x1={0} x2={W} y1={y(snap.budget.budget_inr)} y2={y(snap.budget.budget_inr)} stroke="rgba(221,227,236,0.45)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={d} fill="none" stroke={C_FORECAST} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
