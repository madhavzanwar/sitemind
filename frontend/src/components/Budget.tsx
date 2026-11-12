import { useEffect, useRef, useState } from 'react'
import { Wallet } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { cx, dateTime, inr, parseTime, pct } from '../lib/format'
import { Card, Label } from './ui'

const C_FORECAST = '#FFB224'
const C_COMMITTED = '#2DD4BF'
const C_BUDGET = '#B7C0CF'

export function Budget({ snap, className }: { snap: RunSnapshot; className?: string }) {
  const b = snap.budget
  const util = b.budget_inr ? b.forecast_inr / b.budget_inr : 0
  const headroom = b.budget_inr - b.forecast_inr
  return (
    <Card testId="budget-chart" title="Budget burn" icon={Wallet} className={className} bodyClassName="flex flex-col">
      <div className="flex items-center gap-4 px-4 pt-3">
        <Gauge value={util} />
        <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2.5">
          <Kv label="Budget" value={inr(b.budget_inr)} />
          <Kv label="Forecast" value={inr(b.forecast_inr)} swatch={C_FORECAST} />
          <Kv label="Committed" value={inr(b.committed_inr)} swatch={C_COMMITTED} />
          <Kv label="Headroom" value={inr(headroom)} tone={headroom < 0 ? 'text-rose-300' : 'text-emerald-300'} />
        </div>
      </div>
      <div className="px-4 pb-1 pt-2 text-[11px] text-ink-400">
        Process spend <span className="num text-ink-200">{inr(b.spent_process_inr)}</span> · forecast = best option + 5 % contingency
      </div>
      <Chart snap={snap} />
    </Card>
  )
}

function Kv({ label, value, swatch, tone }: { label: string; value: string; swatch?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {swatch && <span className="h-[3px] w-3 rounded-full" style={{ background: swatch }} />}
        <Label>{label}</Label>
      </div>
      <div className={cx('num mt-0.5 truncate text-[15px] font-semibold', tone ?? 'text-ink-50')}>{value}</div>
    </div>
  )
}

function Gauge({ value }: { value: number }) {
  const r = 46
  const c = Math.PI * r
  const v = Math.max(0, Math.min(1.2, value))
  const color = value > 1 ? '#F43F5E' : value > 0.95 ? '#FB923C' : '#34D399'
  // arc spans 0..120 % of budget; 100 % tick shown
  const frac = v / 1.2
  const tick = 1 / 1.2
  const ang = Math.PI * (1 - tick)
  return (
    <div className="relative h-[78px] w-[124px] shrink-0" data-testid="budget-gauge">
      <svg viewBox="0 0 124 72" className="h-full w-full overflow-visible">
        <path d={`M ${62 - r} 62 A ${r} ${r} 0 0 1 ${62 + r} 62`} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={9} strokeLinecap="round" />
        <path
          d={`M ${62 - r} 62 A ${r} ${r} 0 0 1 ${62 + r} 62`}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={`${frac * c} ${c}`}
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.2,.8,.2,1), stroke .4s' }}
        />
        <line
          x1={62 + Math.cos(ang) * (r - 8)}
          y1={62 - Math.sin(ang) * (r - 8)}
          x2={62 + Math.cos(ang) * (r + 8)}
          y2={62 - Math.sin(ang) * (r + 8)}
          stroke="#DDE3EC"
          strokeWidth={2}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="num text-[19px] font-semibold leading-none" style={{ color }}>
          {pct(value)}
        </div>
        <div className="mt-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-400">utilisation</div>
      </div>
    </div>
  )
}

function Chart({ snap }: { snap: RunSnapshot }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hi, setHi] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const b = snap.budget
  const pts = b.points.map((p) => ({ t: parseTime(p.sim_time), f: p.forecast_inr, c: p.committed_inr, iso: p.sim_time }))
  const nowT = parseTime(snap.sim_now)
  const t0 = parseTime(snap.sim_start)
  const t1 = Math.max(nowT, t0 + 86_400_000 * 7, ...pts.map((p) => p.t))
  const vals = [b.budget_inr, ...pts.map((p) => p.f)].filter((x) => x > 0)
  const vMax = Math.max(...vals) * 1.06
  const vMin = Math.min(...vals) * 0.82
  const L = 52
  const R = 14
  const T = 12
  const B = 22
  const { w, h } = size
  const pw = Math.max(0, w - L - R)
  const ph = Math.max(0, h - T - B)
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * pw
  const y = (v: number) => T + ph - ((Math.max(vMin, Math.min(vMax, v)) - vMin) / (vMax - vMin || 1)) * ph
  const step = (key: 'f' | 'c') => {
    if (!pts.length) return ''
    let d = `M${x(t0)},${y(pts[0]![key])}`
    pts.forEach((p, i) => {
      if (i > 0) d += ` H${x(p.t)}`
      d += ` V${y(p[key])}`
    })
    d += ` H${x(nowT)}`
    return d
  }
  const ticks = 4
  const ty = Array.from({ length: ticks + 1 }, (_, i) => vMin + ((vMax - vMin) * i) / ticks)
  const fPath = step('f')
  const hp = hi != null ? pts[hi] : null
  const over = pts.some((p) => p.f > b.budget_inr)
  return (
    <div ref={ref} className="relative min-h-0 flex-1" onMouseLeave={() => setHi(null)}>
      {w > 0 && pts.length > 0 && (
        <svg
          width={w}
          height={h}
          className="absolute inset-0"
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const mx = e.clientX - rect.left
            let best = 0
            pts.forEach((p, i) => {
              if (Math.abs(x(p.t) - mx) < Math.abs(x(pts[best]!.t) - mx)) best = i
            })
            setHi(best)
          }}
        >
          <defs>
            <linearGradient id="fArea" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={C_FORECAST} stopOpacity="0.22" />
              <stop offset="1" stopColor={C_FORECAST} stopOpacity="0" />
            </linearGradient>
            <clipPath id="overBudget">
              <rect x={L} y={T} width={pw} height={Math.max(0, y(b.budget_inr) - T)} />
            </clipPath>
          </defs>
          {ty.map((v, i) => (
            <g key={i}>
              <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.045)" />
              <text x={L - 8} y={y(v) + 3.5} textAnchor="end" className="fill-ink-400 font-mono text-[9.5px]">
                {(v / 1e7).toFixed(1)} Cr
              </text>
            </g>
          ))}
          {[0, 0.5, 1].map((f) => {
            const t = t0 + (t1 - t0) * f
            return (
              <text key={f} x={x(t)} y={h - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="fill-ink-400 font-mono text-[9.5px]">
                {dateTime(new Date(t).toISOString()).slice(0, 6)}
              </text>
            )
          })}
          <path d={`${fPath} V${T + ph} H${x(t0)} Z`} fill="url(#fArea)" />
          {over && <path d={fPath} fill="none" stroke="#F43F5E" strokeWidth={6} opacity={0.25} clipPath="url(#overBudget)" />}
          <line x1={L} x2={w - R} y1={y(b.budget_inr)} y2={y(b.budget_inr)} stroke={C_BUDGET} strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={L + 6} y={y(b.budget_inr) - 5} className="fill-ink-200 text-[10px] font-medium">
            Budget {inr(b.budget_inr)}
          </text>
          <path d={fPath} fill="none" stroke={C_FORECAST} strokeWidth={2} strokeLinejoin="round" />
          <path d={step('c')} fill="none" stroke={C_COMMITTED} strokeWidth={2} strokeLinejoin="round" />
          {pts.map((p, i) => (
            <circle key={i} cx={x(p.t)} cy={y(p.f)} r={i === hi ? 4.5 : 3} fill={p.f > b.budget_inr ? '#F43F5E' : C_FORECAST} stroke="#0A0D13" strokeWidth={2} />
          ))}
          <text x={L + 6} y={y(vMin) - 5} className="fill-ink-500 text-[9px]">
            Committed · axis starts at {(vMin / 1e7).toFixed(1)} Cr
          </text>
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={T} y2={T + ph} stroke="rgba(255,255,255,0.25)" />
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div
          className="pointer-events-none absolute z-10 w-max -translate-x-1/2 rounded-lg border border-white/10 bg-ink-800/95 px-3 py-2 text-[11.5px] shadow-xl"
          style={{ left: Math.min(Math.max(x(hp.t), 90), w - 90), top: 4 }}
        >
          <div className="font-mono text-[10px] text-ink-400">{dateTime(hp.iso)}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-[3px] w-3 rounded-full" style={{ background: C_FORECAST }} /> Forecast <span className="num ml-auto pl-3 text-ink-50">{inr(hp.f)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-[3px] w-3 rounded-full" style={{ background: C_COMMITTED }} /> Committed <span className="num ml-auto pl-3 text-ink-50">{inr(hp.c)}</span>
          </div>
        </div>
      )}
      {pts.length === 0 && <div className="grid h-full place-items-center text-xs text-ink-400">No budget data yet</div>}
    </div>
  )
}
