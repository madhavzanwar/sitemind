import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Calculator,
  CalendarRange,
  CheckCircle2,
  Circle,
  CircleDashed,
  FileSignature,
  FileText,
  Hand,
  Loader2,
  MessageSquareQuote,
  Network,
  Brain,
  XCircle,
  Ban,
  type LucideIcon,
} from 'lucide-react'
import type { AuditEntry, Plan, PlanTask, RunSnapshot } from '../types'
import { cx, dayMonth } from '../lib/format'
import { TASK_LABEL, TASK_TONE, TONE } from '../lib/status'
import { Card } from './ui'

const SPECIALIST_ICON: Record<string, LucideIcon> = {
  planner: Brain,
  takeoff: FileText,
  quotes: MessageSquareQuote,
  schedule: CalendarRange,
  budget: Calculator,
  approvals: Hand,
  po: FileSignature,
}

const STATUS_ICON: Record<PlanTask['status'], LucideIcon> = {
  pending: Circle,
  ready: CircleDashed,
  running: Loader2,
  waiting_human: Hand,
  done: CheckCircle2,
  failed: XCircle,
  skipped: Ban,
}

const NODE_W = 150
const NODE_H = 58
const SKIP_H = 40
const COL_GAP = 26
const SUB_GAP = 12
const ROW_GAP = 12
const PAD = 8
const MAX_ROWS = 3

interface Placed {
  task: PlanTask
  x: number
  y: number
  h: number
}

function layout(plan: Plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const depth = new Map<string, number>()
  const visit = (id: string, stack: Set<string>): number => {
    const known = depth.get(id)
    if (known != null) return known
    if (stack.has(id)) return 0
    stack.add(id)
    const t = byId.get(id)
    const deps = (t?.depends_on ?? []).filter((d) => byId.has(d))
    const d = deps.length ? Math.max(...deps.map((x) => visit(x, stack))) + 1 : 0
    stack.delete(id)
    depth.set(id, d)
    return d
  }
  plan.tasks.forEach((t) => visit(t.id, new Set()))
  const nDepth = Math.max(0, ...depth.values()) + 1
  // Each depth becomes one or more sub-columns of at most MAX_ROWS active tasks.
  const active: PlanTask[][] = Array.from({ length: nDepth }, () => [])
  const skipped: PlanTask[][] = Array.from({ length: nDepth }, () => [])
  plan.tasks.forEach((t) => (t.status === 'skipped' ? skipped : active)[depth.get(t.id) ?? 0]!.push(t))
  const subCols = active.map((ts, d) => Math.max(1, Math.ceil(ts.length / MAX_ROWS), Math.ceil(skipped[d]!.length / 2)))
  const activeRows = Math.max(1, ...active.map((ts, d) => Math.ceil(ts.length / subCols[d]!)))
  const skippedRows = Math.max(0, ...skipped.map((ts, d) => Math.ceil(ts.length / subCols[d]!)))
  const bandGap = skippedRows ? 22 : 0
  const activeH = activeRows * (NODE_H + ROW_GAP) - ROW_GAP
  const placed: Placed[] = []
  let x = PAD
  for (let d = 0; d < nDepth; d++) {
    const n = subCols[d]!
    const perCol = Math.ceil(active[d]!.length / n) || 1
    for (let c = 0; c < n; c++) {
      const col = active[d]!.slice(c * perCol, (c + 1) * perCol)
      const off = (activeH - (col.length * (NODE_H + ROW_GAP) - ROW_GAP)) / 2
      const cx = x + c * (NODE_W + SUB_GAP)
      col.forEach((t, i) => placed.push({ task: t, x: cx, y: PAD + off + i * (NODE_H + ROW_GAP), h: NODE_H }))
    }
    const sk = skipped[d]!
    const skPer = Math.ceil(sk.length / n) || 1
    sk.forEach((t, i) => {
      const c = Math.floor(i / skPer)
      const r = i % skPer
      placed.push({ task: t, x: x + c * (NODE_W + SUB_GAP), y: PAD + activeH + ROW_GAP + bandGap + r * (SKIP_H + ROW_GAP), h: SKIP_H })
    })
    x += n * NODE_W + (n - 1) * SUB_GAP + COL_GAP
  }
  const width = x - COL_GAP + PAD
  const height = PAD * 2 + activeH + (skippedRows ? ROW_GAP + bandGap + skippedRows * (SKIP_H + ROW_GAP) - ROW_GAP : 0)
  const bandY = skippedRows ? PAD + activeH + ROW_GAP / 2 + bandGap / 2 : null
  return { placed, width, height, bandY }
}

function diffPlans(prev: Plan | undefined, cur: Plan) {
  if (!prev) return null
  const old = new Map(prev.tasks.map((t) => [t.id, t]))
  const added = cur.tasks.filter((t) => !old.has(t.id)).length
  const superseded = cur.tasks.filter((t) => t.status === 'skipped' && old.get(t.id)?.status !== 'skipped').length
  return { added, superseded }
}

function triggerFor(plan: Plan, audit: AuditEntry[]): string | null {
  const e = audit.find((a) => a.action.includes('replan') && (a.plan_version === plan.version || a.outputs?.version === plan.version))
  const trig = e?.inputs?.trigger ?? e?.outputs?.trigger
  if (typeof trig === 'string') return trig.replace(/_/g, ' ')
  const first = plan.rationale.split(/[.:;]/)[0]
  return first ? first.slice(0, 48) : null
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

export function TaskGraph({ snap, className }: { snap: RunSnapshot; className?: string }) {
  const history = snap.plan_history.length ? snap.plan_history : snap.plan ? [snap.plan] : []
  const latest = snap.plan?.version ?? 0
  const [picked, setPicked] = useState<number | null>(null)
  const version = picked ?? latest
  // Show the live plan for the latest version; history entries are frozen at re-plan time.
  const plan = version === latest ? snap.plan : history.find((p) => p.version === version) ?? snap.plan
  const idx = history.findIndex((p) => p.version === version)
  const diff = plan ? diffPlans(history[idx - 1], plan) : null
  const trigger = plan && diff ? triggerFor(plan, snap.audit) : null
  const killed = snap.status === 'killed'

  const lay = useMemo(() => (plan ? layout(plan) : null), [plan])
  const [ref, size] = useSize<HTMLDivElement>()
  // Fit to the card, but never shrink node text below a readable size: overflow scrolls instead.
  const MIN_SCALE = 0.82
  const scale = lay && size.w ? Math.max(MIN_SCALE, Math.min(1.15, size.w / lay.width, size.h / lay.height)) : 1

  const pos = useMemo(() => new Map(lay?.placed.map((p) => [p.task.id, p]) ?? []), [lay])

  return (
    <Card
      testId="task-graph"
      title="Task graph"
      icon={Network}
      className={className}
      subtitle={plan ? `${plan.tasks.filter((t) => t.status !== 'skipped').length} active tasks · layered by dependency depth` : undefined}
      right={
        <>
          {diff && (
            <span data-testid="plan-diff" className="mr-2 flex items-center gap-2 text-[11.5px] text-ink-300">
              <span className="font-mono font-semibold text-accent-300">v{version}</span>
              <span className="text-emerald-300">+{diff.added} tasks</span>
              <span className="text-ink-500">·</span>
              <span className="text-ink-300">{diff.superseded} superseded</span>
              {trigger && (
                <>
                  <span className="text-ink-500">·</span>
                  <span>
                    trigger: <span className="text-orange-300">{trigger}</span>
                  </span>
                </>
              )}
            </span>
          )}
          <div className="flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-inset ring-white/[0.06]" role="tablist" aria-label="Plan version">
            {history.map((p) => (
              <button
                key={p.version}
                data-testid={`plan-v${p.version}`}
                onClick={() => setPicked(p.version === latest ? null : p.version)}
                className={cx(
                  'rounded-md px-2.5 py-0.5 font-mono text-[11.5px] font-semibold transition',
                  p.version === version ? 'bg-accent-400 text-ink-950' : 'text-ink-300 hover:text-ink-50',
                )}
              >
                v{p.version}
              </button>
            ))}
          </div>
        </>
      }
    >
      <div ref={ref} className={cx('grid-bg relative flex h-full w-full overflow-auto', killed && 'saturate-[0.35]')}>
        {lay && plan ? (
          <div
            data-testid="task-graph-canvas"
            data-scale={scale.toFixed(2)}
            className="relative m-auto shrink-0"
            style={{ width: lay.width * scale, height: lay.height * scale }}
          >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: lay.width, height: lay.height, transform: `scale(${scale})` }}
          >
            <svg className="absolute inset-0 overflow-visible" width={lay.width} height={lay.height}>
              <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 8 4 0 8z" fill="rgba(255,255,255,0.25)" />
                </marker>
              </defs>
              {lay.bandY != null && (
                <g>
                  <line x1={0} x2={lay.width} y1={lay.bandY} y2={lay.bandY} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 5" />
                  <text x={PAD} y={lay.bandY - 6} className="fill-ink-500 text-[9.5px] font-semibold uppercase tracking-[0.14em]">
                    Superseded by re-plan
                  </text>
                </g>
              )}
              {lay.placed.flatMap(({ task, x, y, h }) =>
                task.depends_on.map((dep) => {
                  const src = pos.get(dep)
                  if (!src) return null
                  const x1 = src.x + NODE_W
                  const y1 = src.y + src.h / 2
                  const x2 = x
                  const y2 = y + h / 2
                  const mx = (x1 + x2) / 2
                  const skipped = task.status === 'skipped'
                  const live = task.status === 'running' || task.status === 'waiting_human'
                  const done = src.task.status === 'done' && task.status === 'done'
                  return (
                    <path
                      key={`${dep}->${task.id}`}
                      d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`}
                      fill="none"
                      stroke={live ? TONE[TASK_TONE[task.status]].hex : done ? 'rgba(52,211,153,0.45)' : 'rgba(255,255,255,0.14)'}
                      strokeWidth={live ? 1.75 : 1.25}
                      strokeDasharray={skipped ? '3 4' : live ? '5 5' : undefined}
                      className={live && !killed ? 'animate-dash' : undefined}
                      opacity={skipped ? 0.5 : 1}
                    />
                  )
                }),
              )}
            </svg>
            {lay.placed.map(({ task, x, y, h }) => (
              <Node key={task.id} task={task} x={x} y={y} h={h} frozen={killed} />
            ))}
          </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm text-ink-400">Planner is decomposing the goal…</div>
        )}
      </div>
    </Card>
  )
}

function Node({ task, x, y, h, frozen }: { task: PlanTask; x: number; y: number; h: number; frozen: boolean }) {
  const tone = TONE[TASK_TONE[task.status]]
  const SIcon = SPECIALIST_ICON[task.specialist] ?? Network
  const StIcon = STATUS_ICON[task.status]
  const skipped = task.status === 'skipped'
  const live = task.status === 'running' || task.status === 'waiting_human'
  const meta = skipped
    ? 'superseded'
    : task.status === 'done' && task.finished_at
      ? `done ${dayMonth(task.finished_at)}`
      : task.status === 'running'
        ? frozen
          ? 'frozen'
          : 'running…'
        : task.status === 'waiting_human'
          ? 'awaiting PM'
          : task.deadline
            ? `due ${dayMonth(task.deadline)}`
            : TASK_LABEL[task.status].toLowerCase()
  return (
    <div
      data-testid={`task-${task.id}`}
      data-status={task.status}
      title={`${task.id} · ${TASK_LABEL[task.status]}${task.note ? ` — ${task.note}` : ''}`}
      className={cx(
        cx('absolute flex flex-col justify-between rounded-xl border px-2.5 transition-all duration-500', skipped ? 'py-1' : 'py-1.5'),
        skipped
          ? 'border-dashed border-white/10 bg-ink-950/40 opacity-60'
          : task.status === 'pending'
            ? 'border-white/[0.07] bg-ink-850'
            : 'bg-ink-850',
        !skipped && task.status !== 'pending' && 'border-transparent',
      )}
      style={{
        left: x,
        top: y,
        width: NODE_W,
        height: h,
        boxShadow:
          !skipped && task.status !== 'pending'
            ? `inset 0 0 0 1px ${tone.hex}${live ? '99' : '40'}${live && !frozen ? `, 0 0 22px -6px ${tone.hex}` : ''}`
            : undefined,
      }}
    >
      {skipped ? (
        <div className="flex h-full items-center gap-2">
          <Ban className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          <div className="min-w-0">
            <div className="truncate text-[11.5px] font-medium leading-tight text-ink-400 line-through decoration-ink-400/70">{task.title}</div>
            <div className="truncate font-mono text-[9px] text-ink-500">{task.id} · superseded</div>
          </div>
        </div>
      ) : (
      <>
      <div className="flex items-center gap-1.5">
        <SIcon className={cx('h-3 w-3 shrink-0', skipped ? 'text-ink-500' : 'text-ink-300')} strokeWidth={2} />
        <span className="truncate font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-400">{task.specialist}</span>
        {task.plan_version > 1 && !skipped && (
          <span className="rounded bg-accent-400/15 px-1 font-mono text-[9px] font-semibold text-accent-300">v{task.plan_version}</span>
        )}
        <StIcon
          className={cx('ml-auto h-3.5 w-3.5 shrink-0', tone.text, task.status === 'running' && !frozen && 'animate-spin', skipped && 'text-ink-500')}
          strokeWidth={2.25}
        />
      </div>
      <div className={cx('truncate text-[12.5px] font-semibold leading-[1.3]', skipped ? 'text-ink-400 line-through decoration-ink-400/70' : 'text-ink-50')}>
        {task.title}
      </div>
      <div className="flex items-center justify-between">
        <span className={cx('font-mono text-[9.5px]', live ? tone.text : 'text-ink-400')}>{meta}</span>
        {task.attempts > 1 && <span className="font-mono text-[9.5px] text-orange-300">×{task.attempts}</span>}
      </div>
      </>
      )}
    </div>
  )
}
