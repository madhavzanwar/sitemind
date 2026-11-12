import { Fragment, useMemo, useState } from 'react'
import { ChevronRight, Copy, KeyRound, Repeat2, ScrollText, Search, ShieldCheck } from 'lucide-react'
import type { AuditEntry, LedgerEntry, RunSnapshot } from '../types'
import { cx, dateTime, inr, pct } from '../lib/format'
import { Badge, Card, Empty } from './ui'

const ACTOR_TONE: Record<string, string> = {
  planner: 'text-accent-300',
  human: 'text-violet-300',
  system: 'text-rose-300',
  takeoff: 'text-sky-300',
  quotes: 'text-sky-300',
  schedule: 'text-sky-300',
  budget: 'text-sky-300',
  approvals: 'text-sky-300',
  po: 'text-emerald-300',
}

export function Audit({ snap }: { snap: RunSnapshot }) {
  const [view, setView] = useState<'audit' | 'ledger'>('audit')
  const [q, setQ] = useState('')
  const [actor, setActor] = useState<string | null>(null)
  const actors = useMemo(() => [...new Set(snap.audit.map((a) => a.actor))], [snap.audit])
  const dedup = snap.ledger.filter((l) => l.executions > 1).length

  return (
    <Card
      testId="audit-trail"
      title={
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-inset ring-white/[0.06]">
          {(
            [
              ['audit', `Audit trail · ${snap.audit.length}`],
              ['ledger', `Action ledger · ${snap.ledger.length}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              data-testid={`audit-view-${k}`}
              onClick={() => setView(k)}
              className={cx('rounded-md px-3 py-1 text-[12px] font-semibold transition', view === k ? 'bg-ink-700 text-ink-50 shadow' : 'text-ink-400 hover:text-ink-100')}
            >
              {label}
            </button>
          ))}
        </div>
      }
      icon={ScrollText}
      right={
        <div className="flex items-center gap-2">
          {view === 'audit' && (
            <div className="flex items-center gap-1">
              {[null, ...actors].map((a) => (
                <button
                  key={a ?? 'all'}
                  onClick={() => setActor(a)}
                  className={cx(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium transition',
                    actor === a ? 'bg-accent-400/15 text-accent-300 ring-1 ring-inset ring-accent-400/30' : 'text-ink-400 hover:text-ink-100',
                  )}
                >
                  {a ?? 'all'}
                </button>
              ))}
            </div>
          )}
          {view === 'ledger' && dedup > 0 && (
            <Badge tone="success">
              <ShieldCheck className="h-3 w-3" /> {dedup} keys deduplicated on resume
            </Badge>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
            <input
              data-testid="audit-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={view === 'audit' ? 'Search actions, summaries…' : 'Search keys…'}
              className="field h-8 w-64 py-1 pl-8 text-[12.5px]"
            />
          </div>
        </div>
      }
      className="h-full"
      bodyClassName="overflow-auto"
    >
      {view === 'audit' ? <AuditTable rows={filterAudit(snap.audit, q, actor)} /> : <LedgerTable rows={filterLedger(snap.ledger, q)} />}
    </Card>
  )
}

function filterAudit(rows: AuditEntry[], q: string, actor: string | null) {
  const s = q.trim().toLowerCase()
  return rows
    .filter((r) => !actor || r.actor === actor)
    .filter((r) => !s || `${r.actor} ${r.action} ${r.summary} ${r.task_id ?? ''}`.toLowerCase().includes(s))
    .slice()
    .reverse()
}
function filterLedger(rows: LedgerEntry[], q: string) {
  const s = q.trim().toLowerCase()
  const out = rows.filter((r) => !s || `${r.idempotency_key} ${r.kind}`.toLowerCase().includes(s)).slice().reverse()
  // keys re-requested after a resume (executions > 1) go first so the dedup is obvious
  return [...out.filter((r) => r.executions > 1), ...out.filter((r) => r.executions <= 1)]
}

function AuditTable({ rows }: { rows: AuditEntry[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  if (!rows.length) return <Empty icon={ScrollText} title="No audit entries" />
  return (
    <table className="w-full text-[12.5px]" data-testid="audit-table">
      <thead className="sticky top-0 z-10 bg-ink-900/95 backdrop-blur">
        <tr className="border-b border-white/[0.06]">
          <th className="th w-8" />
          <th className="th w-14">#</th>
          <th className="th w-36">Sim time</th>
          <th className="th w-28">Actor</th>
          <th className="th w-52">Action</th>
          <th className="th">Summary</th>
          <th className="th w-28 text-right">Cost</th>
          <th className="th w-32 text-right">Confidence</th>
          <th className="th w-16 text-center">Plan</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isOpen = open.has(r.seq)
          const kill = r.action.includes('kill')
          return (
            <Fragment key={r.seq}>
              <tr
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s)
                    if (n.has(r.seq)) n.delete(r.seq)
                    else n.add(r.seq)
                    return n
                  })
                }
                className={cx('cursor-pointer border-b border-white/[0.04] transition hover:bg-white/[0.02]', isOpen && 'bg-white/[0.02]', kill && 'bg-rose-500/[0.05]')}
              >
                <td className="td text-ink-500">
                  <ChevronRight className={cx('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
                </td>
                <td className="td num text-ink-500">{r.seq}</td>
                <td className="td num whitespace-nowrap text-ink-300">{dateTime(r.sim_time)}</td>
                <td className={cx('td font-mono text-[11.5px] font-medium', ACTOR_TONE[r.actor] ?? 'text-ink-200')}>{r.actor}</td>
                <td className="td">
                  <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink-100 ring-1 ring-inset ring-white/[0.06]">{r.action}</span>
                </td>
                <td className="td max-w-0 text-ink-200">
                  <div className="truncate">{r.summary}</div>
                </td>
                <td className="td num text-right text-ink-200">{r.cost_inr ? inr(r.cost_inr) : <span className="text-ink-600">—</span>}</td>
                <td className="td text-right">
                  {r.confidence != null ? (
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="h-1 w-10 overflow-hidden rounded-full bg-white/[0.06]">
                        <span className="block h-full rounded-full bg-sky-400" style={{ width: `${r.confidence * 100}%` }} />
                      </span>
                      <span className="num text-[11.5px] text-ink-300">{pct(r.confidence)}</span>
                    </span>
                  ) : (
                    <span className="text-ink-600">—</span>
                  )}
                </td>
                <td className="td text-center">{r.plan_version != null && <span className="font-mono text-[11px] text-accent-300">v{r.plan_version}</span>}</td>
              </tr>
              {isOpen && (
                <tr className="border-b border-white/[0.04] bg-ink-950/50">
                  <td />
                  <td colSpan={8} className="px-3 pb-4 pt-2">
                    <p className="mb-3 text-[13px] leading-relaxed text-ink-100">{r.summary}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <Json label="inputs" value={r.inputs} />
                      <Json label="outputs" value={r.outputs} />
                    </div>
                    <div className="mt-2 flex gap-4 font-mono text-[10.5px] text-ink-500">
                      <span>task {r.task_id ?? '—'}</span>
                      <span>llm tokens {r.llm_tokens}</span>
                      <span>wall {new Date(r.wall_time).toLocaleTimeString()}</span>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-ink-950/80">
      <div className="flex items-center justify-between border-b border-white/[0.05] px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-400">{label}</span>
        <button onClick={() => void navigator.clipboard?.writeText(JSON.stringify(value, null, 2))} className="text-ink-500 hover:text-ink-200" aria-label="Copy JSON">
          <Copy className="h-3 w-3" />
        </button>
      </div>
      <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-200">{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

function LedgerTable({ rows }: { rows: LedgerEntry[] }) {
  if (!rows.length) return <Empty icon={KeyRound} title="Ledger is empty" hint="Every side effect (RFQ, approval request, LLM call, PO dispatch) is recorded here under an idempotency key." />
  const dups = rows.filter((r) => r.executions > 1)
  return (
    <>
    {dups.length > 0 && (
      <div data-testid="dedup-banner" className="m-3 flex items-start gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-emerald-200">
            Deduplicated on resume — {dups.length} side effect{dups.length > 1 ? 's' : ''} requested again after the worker restarted, executed once
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {dups.map((d) => (
              <span key={d.idempotency_key} className="font-mono text-[11px] text-ink-200">
                <span className="text-emerald-300">×{d.executions}</span> {d.kind} · {d.idempotency_key.split(':').slice(1).join(':')}
              </span>
            ))}
          </div>
        </div>
      </div>
    )}
    <table className="w-full text-[12.5px]" data-testid="ledger-table">
      <thead className="sticky top-0 z-10 bg-ink-900/95 backdrop-blur">
        <tr className="border-b border-white/[0.06]">
          <th className="th">Idempotency key</th>
          <th className="th w-44">Kind</th>
          <th className="th w-36">Sim time</th>
          <th className="th">Result</th>
          <th className="th w-56 text-right">Executions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const dup = r.executions > 1
          return (
            <tr key={r.idempotency_key} data-testid={dup ? 'ledger-dedup' : undefined} className={cx('border-b border-white/[0.04]', dup && 'bg-emerald-400/[0.04]')}>
              <td className="td max-w-0">
                <div className="flex items-center gap-2">
                  <KeyRound className={cx('h-3.5 w-3.5 shrink-0', dup ? 'text-emerald-400' : 'text-ink-500')} />
                  <span className="truncate font-mono text-[11.5px] text-ink-100" title={r.idempotency_key}>
                    {r.idempotency_key}
                  </span>
                </div>
              </td>
              <td className="td">
                <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink-200 ring-1 ring-inset ring-white/[0.06]">{r.kind}</span>
              </td>
              <td className="td num whitespace-nowrap text-ink-300">{dateTime(r.sim_time)}</td>
              <td className="td max-w-0">
                <div className="truncate font-mono text-[11px] text-ink-400">{JSON.stringify(r.result)}</div>
              </td>
              <td className="td text-right">
                {dup ? (
                  <Badge tone="success">
                    <Repeat2 className="h-3 w-3" />×{r.executions} requested · executed once
                  </Badge>
                ) : (
                  <span className="num text-ink-400">×1</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    </>
  )
}
