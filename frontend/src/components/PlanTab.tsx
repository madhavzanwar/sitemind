import { GitBranch, ShieldAlert } from 'lucide-react'
import type { PlanTask, RunSnapshot } from '../types'
import { dateTime } from '../lib/format'
import { TaskGraph } from './TaskGraph'
import { triggerFor } from '../lib/plan'
import { Badge, Card } from './ui'

const LEVEL_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const

export function PlanTab({ snap, onSelect }: { snap: RunSnapshot; onSelect: (t: PlanTask) => void }) {
  const history = snap.plan_history.length ? snap.plan_history : snap.plan ? [snap.plan] : []
  const plan = snap.plan
  return (
    <div className="space-y-4">
      <TaskGraph snap={snap} onSelect={onSelect} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Plan history" icon={GitBranch} subtitle={`${history.length} version${history.length === 1 ? '' : 's'}`} bodyClassName="px-5 pb-5">
          <ol className="space-y-3">
            {[...history].reverse().map((p, i, arr) => {
              const prev = arr[i + 1]
              const ids = new Set(prev?.tasks.map((t) => t.id))
              const added = prev ? p.tasks.filter((t) => !ids.has(t.id)).length : p.tasks.length
              const sup = prev ? p.tasks.filter((t) => t.status === 'skipped' && prev.tasks.find((x) => x.id === t.id)?.status !== 'skipped').length : 0
              const trig = prev ? triggerFor(p, snap.audit) : null
              return (
                <li key={p.version} className="rounded-xl bg-white/[0.03] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink-50">Version {p.version}</span>
                    {p.version === plan?.version && <Badge tone="accent">current</Badge>}
                    <span className="num ml-auto text-[13px] text-ink-400">{dateTime(p.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[13px] text-ink-300">
                    {prev ? (
                      <>
                        <span className="text-emerald-300">+{added} tasks</span>, {sup} superseded{trig && <> · trigger: <span className="text-orange-300">{trig}</span></>}
                      </>
                    ) : (
                      `${added} tasks`
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-200">{p.rationale}</p>
                </li>
              )
            })}
          </ol>
        </Card>
        <Card title="Risks the planner is managing" icon={ShieldAlert} bodyClassName="px-2 pb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="th">Risk</th>
                <th className="th">Likelihood</th>
                <th className="th">Impact</th>
              </tr>
            </thead>
            <tbody>
              {(plan?.risks ?? []).map((r) => (
                <tr key={r.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="td">
                    <div className="text-ink-50">{r.title}</div>
                    <div className="mt-0.5 text-[13px] text-ink-400">{r.mitigation}</div>
                  </td>
                  <td className="td">
                    <Badge tone={LEVEL_TONE[r.likelihood]}>{r.likelihood}</Badge>
                  </td>
                  <td className="td">
                    <Badge tone={LEVEL_TONE[r.impact]}>{r.impact}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}
