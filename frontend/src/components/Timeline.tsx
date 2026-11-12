import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import type { RunSnapshot, TimelineEvent } from '../types'
import { cx, dateTime, parseTime } from '../lib/format'
import { EVENT_TONE, LANES, LANE_LABEL, TONE } from '../lib/status'
import { Card } from './ui'

const DAY = 86_400_000
const IST = 5.5 * 3600_000
const LABEL_W = 82
const AXIS_H = 26

function istMidnight(t: number) {
  return Math.floor((t + IST) / DAY) * DAY - IST
}

export function Timeline({ snap, className }: { snap: RunSnapshot; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [h, setH] = useState(0)
  const [hover, setHover] = useState<{ e: TimelineEvent; x: number; y: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (!e) return
      setW(e.contentRect.width)
      setH(e.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lanes = useMemo(() => {
    const extra = [...new Set(snap.timeline.map((e) => e.lane))].filter((l) => !(LANES as readonly string[]).includes(l))
    return [...LANES, ...extra]
  }, [snap.timeline])

  const start = istMidnight(parseTime(snap.sim_start))
  const nowT = parseTime(snap.sim_now)
  const lastEvt = Math.max(nowT, ...snap.timeline.map((e) => parseTime(e.sim_time)))
  const end = Math.max(start + 8 * DAY, istMidnight(lastEvt) + 2 * DAY)
  const days = Math.round((end - start) / DAY)
  const plotW = Math.max(0, w - LABEL_W - 16)
  const laneH = Math.max(18, (h - AXIS_H - 6) / lanes.length)
  const xOf = (t: number) => LABEL_W + ((t - start) / (end - start)) * plotW
  const yOf = (lane: string) => AXIS_H + lanes.indexOf(lane) * laneH + laneH / 2
  const tickEvery = plotW / days < 44 ? 2 : 1

  // Direct labels: each lane has three label tracks (inline, above, below); a label takes the
  // first track where it doesn't collide. Inline labels must also stop before the next dot.
  const labelled = useMemo(() => {
    const ends = new Map<string, number>()
    const out = new Map<number, number>()
    const items = snap.timeline.map((e, i) => ({ e, i, x: xOf(parseTime(e.sim_time)) })).sort((a, b) => a.x - b.x)
    items.forEach(({ e, i, x }, k) => {
      const width = e.label.length * 5.6 + 12
      const next = items.slice(k + 1).find((o) => o.e.lane === e.lane && o.x > x + 2)
      for (let t = 0; t < 3; t++) {
        const key = `${e.lane}:${t}`
        const prev = ends.get(key) ?? -Infinity
        const limit = t === 0 ? Math.min(next ? next.x - 8 : Infinity, w - 4) : w - 4
        const start = t === 0 ? x : x - 6
        if (start > prev + 6 && x + width < limit) {
          out.set(i, t)
          ends.set(key, x + width)
          break
        }
      }
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.timeline, w, h, start, end])

  const kills = snap.timeline.filter((e) => e.kind === 'kill')
  const killed = snap.status === 'killed'

  return (
    <Card
      testId="timeline"
      title="Timeline"
      icon={Activity}
      subtitle={`${snap.timeline.length} events across sim days`}
      className={className}
      right={
        <div className="flex items-center gap-3 text-[11px] text-ink-400">
          {(['success', 'info', 'warning', 'error', 'human', 'kill'] as const).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              {k === 'kill' ? (
                <span className="h-2 w-2 rotate-45 bg-rose-500" />
              ) : (
                <span className="h-2 w-2 rounded-full" style={{ background: TONE[EVENT_TONE[k]].hex }} />
              )}
              {k === 'error' ? 'issue' : k}
            </span>
          ))}
        </div>
      }
    >
      <div ref={ref} className="relative h-full w-full">
        {w > 0 && (
          <svg width={w} height={h} className="absolute inset-0">
            {/* day bands + axis */}
            {Array.from({ length: days }, (_, i) => {
              const t = start + i * DAY
              const x = xOf(t)
              const dow = new Date(t + IST).getUTCDay()
              const weekend = dow === 0 || dow === 6
              return (
                <g key={i}>
                  {weekend && <rect x={x} y={AXIS_H} width={plotW / days} height={h - AXIS_H} fill="rgba(255,255,255,0.018)" />}
                  <line x1={x} x2={x} y1={AXIS_H - 4} y2={h} stroke="rgba(255,255,255,0.04)" />
                  {i % tickEvery === 0 && (
                    <text x={x + 4} y={16} className="fill-ink-400 font-mono text-[10px]">
                      {new Date(t + IST).getUTCDate()} {new Date(t + IST).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}
                    </text>
                  )}
                </g>
              )
            })}
            <line x1={LABEL_W} x2={w - 16} y1={AXIS_H} y2={AXIS_H} stroke="rgba(255,255,255,0.08)" />
            {lanes.map((l, i) => (
              <g key={l}>
                {i > 0 && <line x1={12} x2={w - 16} y1={AXIS_H + i * laneH} y2={AXIS_H + i * laneH} stroke="rgba(255,255,255,0.035)" />}
                <text x={14} y={yOf(l) + 3.5} className="fill-ink-300 text-[11px] font-medium">
                  {LANE_LABEL[l] ?? l}
                </text>
              </g>
            ))}
            {/* kill markers */}
            {kills.map((k, i) => {
              const x = xOf(parseTime(k.sim_time))
              return (
                <g key={`k${i}`}>
                  <line x1={x} x2={x} y1={AXIS_H} y2={h} stroke="#F43F5E" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.75} />
                  <rect x={x - 5} y={AXIS_H - 3} width={10} height={10} transform={`rotate(45 ${x} ${AXIS_H + 2})`} fill="#F43F5E" />
                </g>
              )
            })}
            {/* now */}
            <g>
              <rect x={xOf(start)} y={AXIS_H} width={Math.max(0, xOf(nowT) - xOf(start))} height={h - AXIS_H} fill="url(#elapsed)" />
              <defs>
                <linearGradient id="elapsed" x1="0" x2="1">
                  <stop offset="0" stopColor="rgba(255,178,36,0)" />
                  <stop offset="1" stopColor={killed ? 'rgba(244,63,94,0.07)' : 'rgba(255,178,36,0.05)'} />
                </linearGradient>
              </defs>
              <line x1={xOf(nowT)} x2={xOf(nowT)} y1={AXIS_H} y2={h - 14} stroke={killed ? '#F43F5E' : '#FFB224'} strokeWidth={1.5} />
              <rect x={xOf(nowT) - 16} y={h - 15} width={32} height={13} rx={3} fill={killed ? '#F43F5E' : '#FFB224'} />
              <text x={xOf(nowT)} y={h - 5.5} textAnchor="middle" className="fill-ink-950 font-mono text-[9px] font-bold">
                NOW
              </text>
            </g>
            {/* events */}
            {snap.timeline
              .map((e, i) => [e, i] as const)
              .sort((a, b) => Number(a[0].kind === 'kill') - Number(b[0].kind === 'kill'))
              .map(([e, i]) => {
              const x = xOf(parseTime(e.sim_time))
              const y = yOf(e.lane)
              const c = TONE[EVENT_TONE[e.kind]].hex
              const strong = e.kind !== 'info'
              return (
                <g
                  key={i}
                  onMouseEnter={() => setHover({ e, x, y })}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-default"
                  data-kind={e.kind}
                >
                  <circle cx={x} cy={y} r={11} fill="transparent" />
                  {e.kind === 'kill' ? (
                    <rect x={x - 5} y={y - 5} width={10} height={10} transform={`rotate(45 ${x} ${y})`} fill={c} stroke="#0A0D13" strokeWidth={2} />
                  ) : (
                    <circle cx={x} cy={y} r={strong ? 5 : 4.5} fill={c} stroke="#0A0D13" strokeWidth={2} />
                  )}
                  {labelled.has(i) && (
                    <text
                      x={labelled.get(i) === 0 ? x + 9 : x - 4}
                      y={labelled.get(i) === 0 ? y + 3.5 : labelled.get(i) === 1 ? y - 10 : y + 17}
                      className={cx('text-[10.5px]', strong ? 'fill-ink-100' : 'fill-ink-300')}
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[280px] -translate-x-1/2 rounded-lg border border-white/10 bg-ink-800/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
            style={{ left: hover.x, top: hover.y + 14 }}
          >
            <div className="font-mono text-[10.5px] text-ink-400">
              {dateTime(hover.e.sim_time)} · {LANE_LABEL[hover.e.lane] ?? hover.e.lane}
            </div>
            <div className="mt-0.5 font-medium text-ink-50">{hover.e.label}</div>
          </div>
        )}
      </div>
    </Card>
  )
}
