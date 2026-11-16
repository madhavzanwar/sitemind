import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import type { InjectedEvent, RunSnapshot, TimelineEvent, TimelineKind } from '../types'
import { cx, parseTime } from '../lib/format'
import { EVENT_TONE, LANES, LANE_LABEL, TONE } from '../lib/status'
import { Card } from './ui'

const DAY = 86_400_000
const IST = 5.5 * 3600_000
const LABEL_W = 96
const AXIS_H = 30
const LANE_H = 38
const SEVERITY: TimelineKind[] = ['info', 'success', 'human', 'warning', 'error', 'kill']

const dayKey = (t: number) => new Date(t + IST).toISOString().slice(0, 10)
const istMidnight = (t: number) => Math.floor((t + IST) / DAY) * DAY - IST

interface Cluster {
  lane: string
  day: string
  t: number
  events: TimelineEvent[]
  injected: InjectedEvent[]
  kind: TimelineKind
}

export function Timeline({ snap, className, onOpen }: { snap: RunSnapshot; className?: string; onOpen: (lane: string, day: string, events: TimelineEvent[]) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ c: Cluster; x: number; y: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const allLanes = useMemo(() => {
    const extra = [...new Set(snap.timeline.map((e) => e.lane))].filter((l) => !(LANES as readonly string[]).includes(l))
    return [...LANES, ...extra]
  }, [snap.timeline])
  const lanes = allLanes.filter((l) => !hidden.has(l))

  const start = istMidnight(parseTime(snap.sim_start))
  const nowT = parseTime(snap.sim_now)
  const lastEvt = Math.max(nowT, ...snap.timeline.map((e) => parseTime(e.sim_time)))
  const end = Math.max(start + 10 * DAY, istMidnight(lastEvt) + 2 * DAY)
  const days = Math.round((end - start) / DAY)
  const plotW = Math.max(0, w - LABEL_W - 20)
  const colW = plotW / days
  const xOfDay = (t: number) => LABEL_W + ((istMidnight(t) - start) / DAY + 0.5) * colW
  const xOf = (t: number) => LABEL_W + ((t - start) / (end - start)) * plotW
  const h = AXIS_H + lanes.length * LANE_H + 8
  const yOf = (lane: string) => AXIS_H + lanes.indexOf(lane) * LANE_H + LANE_H / 2
  const tickEvery = Math.max(1, Math.ceil(56 / Math.max(1, colW)))

  const clusters = useMemo(() => {
    const m = new Map<string, Cluster>()
    for (const e of snap.timeline) {
      const t = parseTime(e.sim_time)
      const k = `${e.lane}|${dayKey(t)}`
      const c = m.get(k) ?? { lane: e.lane, day: dayKey(t), t, events: [], injected: [], kind: 'info' as TimelineKind }
      c.events.push(e)
      if (SEVERITY.indexOf(e.kind) > SEVERITY.indexOf(c.kind)) c.kind = e.kind
      m.set(k, c)
    }
    return [...m.values()]
  }, [snap.timeline])

  const injected = (snap.events ?? []).filter((e) => e.applied_sim_time || e.status === 'pending')
  const kills = snap.timeline.filter((e) => e.kind === 'kill')
  const killed = snap.status === 'killed'
  const toggle = (l: string) =>
    setHidden((s) => {
      const n = new Set(s)
      if (n.has(l)) n.delete(l)
      else n.add(l)
      return n
    })

  return (
    <Card testId="timeline" title="Timeline" icon={Activity} subtitle={`${snap.timeline.length} events · grouped by sim day`} className={className}>
      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2 pt-1">
        {allLanes.map((l) => (
          <button
            key={l}
            onClick={() => toggle(l)}
            aria-pressed={!hidden.has(l)}
            className={cx('rounded-full px-2.5 py-1 text-[13px] transition-colors', hidden.has(l) ? 'text-ink-500 line-through hover:text-ink-300' : 'bg-white/[0.05] text-ink-200 hover:bg-white/[0.09]')}
          >
            {LANE_LABEL[l] ?? l}
          </button>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-ink-400">
          <Legend c={TONE.success.hex} label="Done" />
          <Legend c={TONE.warning.hex} label="Warning" />
          <Legend c={TONE.danger.hex} label="Problem" />
          <Legend c={TONE.human.hex} label="Human" />
          <span className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M5 0 10 9H0z" fill="#FFB224" />
            </svg>
            Injected event
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rotate-45 bg-rose-500" />
            Kill
          </span>
        </span>
      </div>
      <div ref={ref} className="relative w-full px-1 pb-3" style={{ height: h + 12 }}>
        {w > 0 && (
          <svg width={w} height={h} className="absolute left-0 top-0">
            {Array.from({ length: days }, (_, i) => {
              const t = start + i * DAY
              const x = LABEL_W + i * colW
              const dow = new Date(t + IST).getUTCDay()
              return (
                <g key={i}>
                  {(dow === 0 || dow === 6) && <rect x={x} y={AXIS_H} width={colW} height={h - AXIS_H} fill="rgba(255,255,255,0.02)" />}
                  {i % tickEvery === 0 && (
                    <text x={x + colW / 2} y={18} textAnchor="middle" className="fill-ink-400 text-[12px]">
                      {new Date(t + IST).getUTCDate()} {new Date(t + IST).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}
                    </text>
                  )}
                </g>
              )
            })}
            {lanes.map((l, i) => (
              <g key={l}>
                <line x1={12} x2={w - 12} y1={AXIS_H + i * LANE_H} y2={AXIS_H + i * LANE_H} stroke="rgba(255,255,255,0.05)" />
                <text x={16} y={yOf(l) + 4.5} className="fill-ink-300 text-[13px]">
                  {LANE_LABEL[l] ?? l}
                </text>
              </g>
            ))}
            {/* elapsed + now */}
            <rect x={LABEL_W} y={AXIS_H} width={Math.max(0, xOf(nowT) - LABEL_W)} height={h - AXIS_H} fill={killed ? 'rgba(244,63,94,0.05)' : 'rgba(255,178,36,0.035)'} />
            <line x1={xOf(nowT)} x2={xOf(nowT)} y1={AXIS_H - 4} y2={h} stroke={killed ? '#F43F5E' : '#FFB224'} strokeWidth={1.5} />
            {kills.map((k, i) => {
              const x = xOf(parseTime(k.sim_time))
              return <line key={`k${i}`} x1={x} x2={x} y1={AXIS_H} y2={h} stroke="#F43F5E" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} />
            })}
            {clusters
              .filter((c) => lanes.includes(c.lane))
              .sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind))
              .map((c) => {
                const x = xOfDay(c.t)
                const y = yOf(c.lane)
                const col = TONE[EVENT_TONE[c.kind]].hex
                const n = c.events.length
                return (
                  <g
                    key={`${c.lane}|${c.day}`}
                    data-kind={c.kind}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover({ c, x, y })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onOpen(c.lane, c.day, c.events)}
                  >
                    <circle cx={x} cy={y} r={14} fill="transparent" />
                    {c.kind === 'kill' ? (
                      <rect x={x - 7} y={y - 7} width={14} height={14} transform={`rotate(45 ${x} ${y})`} fill={col} />
                    ) : (
                      <circle cx={x} cy={y} r={n > 1 ? 10 : 7} fill={col} fillOpacity={0.9} />
                    )}
                    {n > 1 && c.kind !== 'kill' && (
                      <text x={x} y={y + 4} textAnchor="middle" className="pointer-events-none fill-ink-950 text-[11px] font-bold">
                        {n}
                      </text>
                    )}
                  </g>
                )
              })}
            {lanes.includes('human') &&
              injected.map((ev) => {
                const t = ev.applied_sim_time ? parseTime(ev.applied_sim_time) : nowT
                const x = xOf(t)
                const y = yOf('human')
                return (
                  <g key={ev.id} data-testid="timeline-event-marker" className="cursor-pointer" onClick={() => onOpen('human', dayKey(t), [])}>
                    <path d={`M${x} ${y - 9} L${x + 9} ${y + 7} L${x - 9} ${y + 7}Z`} fill="#FFB224" stroke="#0A0D13" strokeWidth={1.5} opacity={ev.status === 'pending' ? 0.5 : 1} />
                    <title>{`${ev.id}: ${ev.type.replace(/_/g, ' ')}${ev.vendor_id ? ` on ${ev.vendor_id}` : ''}${ev.outcome ? ` — ${ev.outcome}` : ''}`}</title>
                  </g>
                )
              })}
          </svg>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[320px] -translate-x-1/2 rounded-xl border border-white/10 bg-ink-800 px-3.5 py-2.5 text-sm shadow-2xl"
            style={{ left: Math.min(Math.max(hover.x, 170), w - 170), top: hover.y + 18 }}
          >
            <div className="text-[12px] text-ink-400">
              {LANE_LABEL[hover.c.lane] ?? hover.c.lane} · {hover.c.day} · click for details
            </div>
            <ul className="mt-1 space-y-0.5">
              {hover.c.events.slice(0, 6).map((e, i) => (
                <li key={i} className="flex gap-2 text-ink-50">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[EVENT_TONE[e.kind]].hex }} />
                  {e.label}
                </li>
              ))}
              {hover.c.events.length > 6 && <li className="text-ink-400">+{hover.c.events.length - 6} more</li>}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function Legend({ c, label }: { c: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
      {label}
    </span>
  )
}
