import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  Brain,
  Calculator,
  CalendarRange,
  CheckCircle2,
  Circle,
  CircleDashed,
  FileSignature,
  FileText,
  Hand,
  Loader2,
  Maximize2,
  MessageSquareQuote,
  Minus,
  Network,
  Plus,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { AuditEntry, Plan, PlanTask, RunSnapshot } from '../types'
import { cx, dayMonth } from '../lib/format'
import { TASK_LABEL, TASK_TONE, TONE } from '../lib/status'
import { Card } from './ui'

export const SPECIALIST_ICON: Record<string, LucideIcon> = {
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

const NODE_W = 184
const NODE_H = 86
const SKIP_H = 46
const COL_GAP = 36
const SUB_GAP = 14
const ROW_GAP = 14
const PAD = 16
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
    const deps = (byId.get(id)?.depends_on ?? []).filter((d) => byId.has(d))
    const d = deps.length ? Math.max(...deps.map((x) => visit(x, stack))) + 1 : 0
    stack.delete(id)
    depth.set(id, d)
    return d
  }
  plan.tasks.forEach((t) => visit(t.id, new Set()))
  const nDepth = Math.max(0, ...depth.values()) + 1
  const active: PlanTask[][] = Array.from({ length: nDepth }, () => [])
  const skipped: PlanTask[][] = Array.from({ length: nDepth }, () => [])
  plan.tasks.forEach((t) => (t.status === 'skipped' ? skipped : active)[depth.get(t.id) ?? 0]!.push(t))
  const subCols = active.map((ts, d) => Math.max(1, Math.ceil(ts.length / MAX_ROWS), Math.ceil(skipped[d]!.length / 2)))
  const activeRows = Math.max(1, ...active.map((ts, d) => Math.ceil(ts.length / subCols[d]!)))
  const skippedRows = Math.max(0, ...skipped.map((ts, d) => Math.ceil(ts.length / subCols[d]!)))
  const bandGap = skippedRows ? 30 : 0
  const activeH = activeRows * (NODE_H + ROW_GAP) - ROW_GAP
  const placed: Placed[] = []
  let x = PAD
  for (let d = 0; d < nDepth; d++) {
    const n = subCols[d]!
    const perCol = Math.ceil(active[d]!.length / n) || 1
    for (let c = 0; c < n; c++) {
      const col = active[d]!.slice(c * perCol, (c + 1) * perCol)
      const off = (activeH - (col.length * (NODE_H + ROW_GAP) - ROW_GAP)) / 2
      col.forEach((t, i) => placed.push({ task: t, x: x + c * (NODE_W + SUB_GAP), y: PAD + off + i * (NODE_H + ROW_GAP), h: NODE_H }))
    }
    const sk = skipped[d]!
    const skPer = Math.ceil(sk.length / n) || 1
    sk.forEach((t, i) => {
      const c = Math.floor(i / skPer)
      placed.push({ task: t, x: x + c * (NODE_W + SUB_GAP), y: PAD + activeH + ROW_GAP + bandGap + (i % skPer) * (SKIP_H + ROW_GAP), h: SKIP_H })
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
  return {
    added: cur.tasks.filter((t) => !old.has(t.id)).length,
    superseded: cur.tasks.filter((t) => t.status === 'skipped' && old.get(t.id)?.status !== 'skipped').length,
  }
}

export function triggerFor(plan: Plan, audit: AuditEntry[]): string | null {
  const e = audit.find((a) => a.action.includes('replan') && (a.plan_version === plan.version || a.outputs?.version === plan.version))
  const trig = e?.inputs?.trigger ?? e?.outputs?.trigger
  if (typeof trig === 'string') return trig.replace(/_/g, ' ')
  const first = plan.rationale.split(/[.:;]/)[0]
  return first ? first.slice(0, 60) : null
}

const LEGEND: { status: PlanTask['status']; label: string }[] = [
  { status: 'done', label: 'Done' },
  { status: 'running', label: 'Running' },
  { status: 'waiting_human', label: 'Needs you' },
  { status: 'pending', label: 'Pending' },
  { status: 'skipped', label: 'Superseded' },
]

export function TaskGraph({ snap, className, onSelect, compact }: { snap: RunSnapshot; className?: string; onSelect: (t: PlanTask) => void; compact?: boolean }) {
  const history = snap.plan_history.length ? snap.plan_history : snap.plan ? [snap.plan] : []
  const latest = snap.plan?.version ?? 0
  const [picked, setPicked] = useState<number | null>(null)
  const version = picked ?? latest
  const plan = version === latest ? snap.plan : (history.find((p) => p.version === version) ?? snap.plan)
  const idx = history.findIndex((p) => p.version === version)
  const diff = plan ? diffPlans(history[idx - 1], plan) : null
  const trigger = plan && diff ? triggerFor(plan, snap.audit) : null
  const killed = snap.status === 'killed'
  const [zoom, setZoom] = useState(1)
  const lay = useMemo(() => (plan ? layout(plan) : null), [plan])
  const pos = useMemo(() => new Map(lay?.placed.map((p) => [p.task.id, p]) ?? []), [lay])
  const scroller = useRef<HTMLDivElement>(null)

  // keep the active task in view (only when it changes, so polling never jumps the scroll)
  const activeId = plan?.tasks.find((t) => t.status === 'running' || t.status === 'waiting_human')?.id
  useEffect(() => {
    const el = scroller.current
    const p = activeId ? pos.get(activeId) : null
    if (!el || !p) return
    const left = p.x * zoom - el.clientWidth / 2 + (NODE_W * zoom) / 2
    el.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const fit = () => {
    const el = scroller.current
    if (el && lay) setZoom(Math.max(0.55, Math.min(1, (el.clientWidth - 8) / lay.width)))
  }

  return (
    <Card
      testId="task-graph"
      title="Plan"
      icon={Network}
      className={className}
      subtitle={plan ? `${plan.tasks.filter((t) => t.status !== 'skipped').length} tasks · click a task for details` : undefined}
      right={
        <>
          {diff && (
            <span data-testid="plan-diff" className="hidden items-center gap-1.5 text-[13px] text-ink-300 lg:flex">
              v{version}: <span className="text-emerald-300">+{diff.added} tasks</span>, {diff.superseded} superseded
              {trigger && (
                <>
                  {' '}
                  · trigger <span className="text-orange-300">{trigger}</span>
                </>
              )}
            </span>
          )}
          {history.length > 1 && (
            <div className="flex rounded-lg bg-white/[0.05] p-1" role="tablist" aria-label="Plan version">
              {history.map((p) => (
                <button
                  key={p.version}
                  data-testid={`plan-v${p.version}`}
                  onClick={() => setPicked(p.version === latest ? null : p.version)}
                  className={cx('rounded-md px-2.5 py-1 text-[13px] font-semibold transition', p.version === version ? 'bg-accent-400 text-ink-950' : 'text-ink-300 hover:text-ink-50')}
                >
                  v{p.version}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center rounded-lg bg-white/[0.05] p-1">
            <button aria-label="Zoom out" className="grid h-7 w-7 place-items-center rounded text-ink-300 hover:text-ink-50" onClick={() => setZoom((z) => Math.max(0.55, +(z - 0.1).toFixed(2)))}>
              <Minus className="h-4 w-4" />
            </button>
            <button aria-label="Fit to width" className="grid h-7 w-7 place-items-center rounded text-ink-300 hover:text-ink-50" onClick={fit}>
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button aria-label="Zoom in" className="grid h-7 w-7 place-items-center rounded text-ink-300 hover:text-ink-50" onClick={() => setZoom((z) => Math.min(1.3, +(z + 0.1).toFixed(2)))}>
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-1 pt-1 text-[13px] text-ink-400">
        {LEGEND.map((l) => {
          const I = STATUS_ICON[l.status]
          return (
            <span key={l.status} className="inline-flex items-center gap-1.5">
              <I className={cx('h-3.5 w-3.5', l.status === 'skipped' ? 'text-ink-500' : TONE[TASK_TONE[l.status]].text)} />
              {l.label}
            </span>
          )
        })}
      </div>
      <div ref={scroller} className={cx('relative w-full overflow-x-auto overflow-y-hidden pb-2', killed && 'saturate-[0.35]')}>
        {lay && plan ? (
          <div data-testid="task-graph-canvas" data-scale={zoom.toFixed(2)} className="relative" style={{ width: lay.width * zoom, height: (compact ? Math.min(lay.height, 420) : lay.height) * zoom }}>
            <div className="absolute left-0 top-0 origin-top-left" style={{ width: lay.width, height: lay.height, transform: `scale(${zoom})` }}>
              <svg className="absolute inset-0 overflow-visible" width={lay.width} height={lay.height}>
                {lay.bandY != null && (
                  <g>
                    <line x1={PAD} x2={lay.width - PAD} y1={lay.bandY} y2={lay.bandY} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 6" />
                    <text x={PAD} y={lay.bandY - 7} className="fill-ink-400 text-[12px]">
                      Superseded by re-planning
                    </text>
                  </g>
                )}
                {lay.placed.flatMap(({ task, x, y, h }) =>
                  task.depends_on.map((dep) => {
                    const src = pos.get(dep)
                    if (!src) return null
                    const x1 = src.x + NODE_W
                    const y1 = src.y + src.h / 2
                    const y2 = y + h / 2
                    const mx = (x1 + x) / 2
                    const skipped = task.status === 'skipped'
                    const live = task.status === 'running' || task.status === 'waiting_human'
                    const done = src.task.status === 'done' && task.status === 'done'
                    return (
                      <path
                        key={`${dep}->${task.id}`}
                        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x},${y2}`}
                        fill="none"
                        stroke={live ? TONE[TASK_TONE[task.status]].hex : done ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.14)'}
                        strokeWidth={live ? 2 : 1.5}
                        strokeDasharray={skipped ? '3 5' : live ? '6 6' : undefined}
                        className={live && !killed ? 'animate-dash' : undefined}
                        opacity={skipped ? 0.5 : 1}
                      />
                    )
                  }),
                )}
              </svg>
              {lay.placed.map(({ task, x, y, h }) => (
                <Node key={task.id} task={task} x={x} y={y} h={h} frozen={killed} onClick={() => onSelect(task)} />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid h-40 place-items-center text-sm text-ink-400">The planner is decomposing the goal…</div>
        )}
      </div>
    </Card>
  )
}

function Node({ task, x, y, h, frozen, onClick }: { task: PlanTask; x: number; y: number; h: number; frozen: boolean; onClick: () => void }) {
  const tone = TONE[TASK_TONE[task.status]]
  const SIcon = SPECIALIST_ICON[task.specialist] ?? Network
  const StIcon = STATUS_ICON[task.status]
  const skipped = task.status === 'skipped'
  const live = task.status === 'running' || task.status === 'waiting_human'
  const meta =
    task.status === 'done' && task.finished_at
      ? `Done ${dayMonth(task.finished_at)}`
      : task.status === 'running'
        ? frozen
          ? 'Frozen'
          : 'Running…'
        : task.status === 'waiting_human'
          ? 'Needs your approval'
          : task.deadline
            ? `Due ${dayMonth(task.deadline)}`
            : TASK_LABEL[task.status]
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`task-${task.id}`}
      data-status={task.status}
      title={`${task.title} — ${TASK_LABEL[task.status]}${task.note ? ` — ${task.note}` : ''}`}
      className={cx(
        'absolute flex flex-col rounded-xl border text-left transition-[box-shadow,background-color] duration-300 hover:bg-ink-700',
        skipped ? 'justify-center border-dashed border-white/10 bg-transparent px-3 opacity-60' : 'justify-between bg-ink-800 px-3 py-2.5',
        !skipped && (task.status === 'pending' ? 'border-white/[0.07]' : 'border-transparent'),
      )}
      style={{
        left: x,
        top: y,
        width: NODE_W,
        height: h,
        boxShadow: !skipped && task.status !== 'pending' ? `inset 0 0 0 1.5px ${tone.hex}${live ? 'cc' : '55'}${live && !frozen ? `, 0 0 24px -6px ${tone.hex}` : ''}` : undefined,
      }}
    >
      {skipped ? (
        <span className="flex items-center gap-2">
          <Ban className="h-4 w-4 shrink-0 text-ink-500" />
          <span className="truncate text-[13px] text-ink-400 line-through decoration-ink-400/70">{task.title}</span>
        </span>
      ) : (
        <>
          <span className="flex items-start gap-2">
            <SIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-300" strokeWidth={1.9} />
            <span className="line-clamp-2 text-[14px] font-semibold leading-[1.25] text-ink-50">{task.title}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <StIcon className={cx('h-3.5 w-3.5 shrink-0', tone.text, task.status === 'running' && !frozen && 'animate-spin')} strokeWidth={2.25} />
            <span className={cx('truncate text-[12px]', live ? tone.text : 'text-ink-400')}>{meta}</span>
            {task.plan_version > 1 && <span className="ml-auto shrink-0 rounded bg-accent-400/15 px-1.5 text-[11px] font-semibold text-accent-300">v{task.plan_version}</span>}
          </span>
        </>
      )}
    </button>
  )
}
