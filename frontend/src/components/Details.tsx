import { FileText, KeyRound, Repeat2 } from 'lucide-react'
import type { AuditEntry, LedgerEntry, PlanTask, RunSnapshot, TimelineEvent } from '../types'
import { cx, dateTime, inr } from '../lib/format'
import { EVENT_TONE, LANE_LABEL, TASK_LABEL, TASK_TONE, TONE } from '../lib/status'
import { Badge, Confidence, Kv, Label } from './ui'

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mt-6 first:mt-0" data-testid={testId}>
      <h3 className="mb-2.5 text-[13px] font-semibold text-ink-200">{title}</h3>
      {children}
    </section>
  )
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <p className="text-sm text-ink-400">No audit entries recorded yet.</p>
  return (
    <ol className="space-y-3">
      {entries.map((a) => (
        <li key={a.seq} className="rounded-xl bg-white/[0.03] p-3.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className="font-medium text-ink-100">{LANE_LABEL[a.actor] ?? a.actor}</span>
            <span className="font-mono text-[12px] text-ink-400">{a.action}</span>
            <span className="num ml-auto text-[12px] text-ink-500">{dateTime(a.sim_time)}</span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-200">{a.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-400">
            {a.confidence != null && (
              <span className="inline-flex items-center gap-2">
                Confidence <Confidence value={a.confidence} />
              </span>
            )}
            {a.cost_inr > 0 && <span>Cost {inr(a.cost_inr)}</span>}
            {a.llm_tokens > 0 && <span>{a.llm_tokens} LLM tokens</span>}
          </div>
          {(Object.keys(a.inputs).length > 0 || Object.keys(a.outputs).length > 0) && (
            <details className="group mt-2">
              <summary className="cursor-pointer text-[13px] text-accent-300 hover:text-accent-200">Inputs &amp; outputs</summary>
              <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[12px] leading-relaxed text-ink-200">
                {JSON.stringify({ inputs: a.inputs, outputs: a.outputs }, null, 2)}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  )
}

function LedgerList({ entries }: { entries: LedgerEntry[] }) {
  if (!entries.length) return <p className="text-sm text-ink-400">No external side effects for this step.</p>
  return (
    <ul className="space-y-2">
      {entries.map((l) => (
        <li key={l.idempotency_key} className="flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
          <KeyRound className={cx('mt-0.5 h-4 w-4 shrink-0', l.executions > 1 ? 'text-emerald-400' : 'text-ink-400')} />
          <div className="min-w-0 flex-1">
            <div className="break-all font-mono text-[12px] text-ink-100">{l.idempotency_key}</div>
            <div className="mt-0.5 text-[13px] text-ink-400">{l.kind}</div>
          </div>
          {l.executions > 1 && (
            <Badge tone="success">
              <Repeat2 className="h-3 w-3" />×{l.executions} requested, ran once
            </Badge>
          )}
        </li>
      ))}
    </ul>
  )
}

export function TaskDetail({ snap, task }: { snap: RunSnapshot; task: PlanTask }) {
  const entries = snap.audit.filter((a) => a.task_id === task.id)
  const ledger = snap.ledger.filter((l) => l.idempotency_key.includes(`:${task.id}:`))
  const cost = entries.reduce((s, a) => s + a.cost_inr, 0)
  const conf = [...entries].reverse().find((a) => a.confidence != null)?.confidence ?? null
  const tone = TASK_TONE[task.status]
  return (
    <div data-testid="task-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone} dot>
          {TASK_LABEL[task.status]}
        </Badge>
        <span className="text-[13px] text-ink-400">
          {LANE_LABEL[task.specialist] ?? task.specialist} specialist · plan v{task.plan_version}
        </span>
      </div>
      {task.note && <p className="mt-3 rounded-lg bg-orange-400/10 px-3 py-2 text-sm text-orange-100">{task.note}</p>}
      <div className="mt-5 grid grid-cols-2 gap-4">
        <Kv label="Started">{task.started_at ? dateTime(task.started_at) : '—'}</Kv>
        <Kv label="Finished">{task.finished_at ? dateTime(task.finished_at) : '—'}</Kv>
        <Kv label="Deadline">{task.deadline ?? '—'}</Kv>
        <Kv label="Attempts">{task.attempts}</Kv>
        <Kv label="Confidence">
          <Confidence value={conf} />
        </Kv>
        <Kv label="Money committed">{cost ? inr(cost) : '—'}</Kv>
      </div>
      {task.depends_on.length > 0 && (
        <div className="mt-4 text-[13px] text-ink-400">
          Depends on: <span className="text-ink-200">{task.depends_on.join(', ')}</span>
        </div>
      )}

      {task.specialist === 'takeoff' && snap.takeoff && (
        <Section title={`Sources · ${snap.takeoff.document}`} testId="task-sources">
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <table className="w-full text-[13px]">
              <thead className="bg-white/[0.03]">
                <tr>
                  <th className="th">Item</th>
                  <th className="th text-right">Qty</th>
                  <th className="th">Cited from</th>
                </tr>
              </thead>
              <tbody>
                {snap.takeoff.lines.map((l) => (
                  <tr key={l.item_code} className="border-t border-white/[0.05]">
                    <td className="px-4 py-2">
                      <div className="text-ink-100">{l.description}</div>
                      <div className="font-mono text-[12px] text-ink-400">{l.item_code}</div>
                    </td>
                    <td className="num px-4 py-2 text-right text-ink-100">
                      {l.qty} {l.unit}
                    </td>
                    <td className="px-4 py-2 text-ink-300">
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 text-ink-500" />
                        {l.source.replace(snap.takeoff!.document, '').trim() || l.source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {snap.takeoff.warnings.map((w) => (
            <p key={w} className="mt-2 text-[13px] text-orange-200">
              ⚠ {w}
            </p>
          ))}
        </Section>
      )}
      {task.specialist === 'quotes' && snap.quotes.length > 0 && (
        <Section title="Sources · vendor quotes">
          <ul className="space-y-1.5 text-sm">
            {snap.quotes.map((q) => (
              <li key={q.quote_id} className="flex justify-between gap-3">
                <span className="text-ink-200">
                  {q.vendor_name} <span className="font-mono text-[12px] text-ink-400">{q.quote_id}</span>
                </span>
                <span className="num text-ink-50">{inr(q.total_inr)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Reasoning & decisions" testId="task-audit">
        <AuditList entries={entries} />
      </Section>
      <Section title="Side effects (idempotency ledger)">
        <LedgerList entries={ledger} />
      </Section>
    </div>
  )
}

export function MomentDetail({ snap, lane, day, events }: { snap: RunSnapshot; lane: string; day: string; events: TimelineEvent[] }) {
  const dayOf = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10)
  const sameDay = snap.audit.filter((a) => dayOf(a.sim_time) === day)
  const inLane = sameDay.filter((a) => a.actor === lane)
  const entries = inLane.length ? inLane : sameDay
  const injected = (snap.events ?? []).filter((e) => e.applied_sim_time && dayOf(e.applied_sim_time) === day && lane === 'human')
  return (
    <div data-testid="moment-detail">
      <Section title="What happened">
        <ul className="space-y-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[EVENT_TONE[e.kind]].hex }} />
              <div className="min-w-0 flex-1 text-sm text-ink-100">{e.label}</div>
              <span className="num shrink-0 text-[12px] text-ink-500">{dateTime(e.sim_time).slice(-5)}</span>
            </li>
          ))}
          {injected.map((ev) => (
            <li key={ev.id} className="rounded-lg bg-accent-400/[0.07] px-3 py-2.5 text-sm">
              <div className="font-medium text-accent-200">
                Injected: {ev.type.replace(/_/g, ' ')} {ev.vendor_id ?? ''}
              </div>
              {ev.outcome && <div className="mt-1 text-ink-200">{ev.outcome}</div>}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Reasoning & decisions">
        <AuditList entries={entries} />
      </Section>
      <Label className="mt-6">
        Lane: {LANE_LABEL[lane] ?? lane} · {day}
      </Label>
    </div>
  )
}
