// Derived, presentation-level facts about a run snapshot (shared by the Now bar, KPIs and tabs).
import type { ApprovalRequest, PlanTask, RunSnapshot, VendorOption } from '../types'
import { daysBetween, inr } from './format'

export const CONTINGENCY = 0.05
export const committedOf = (o: VendorOption) => o.total_inr + (o.total_inr - o.expedite_fee_inr) * CONTINGENCY

export interface Derived {
  activeTasks: PlanTask[]
  done: number
  total: number
  current: PlanTask | null
  next: PlanTask | null
  pending: ApprovalRequest[]
  pendingApproval: ApprovalRequest | null
  recommended: VendorOption | null
  selected: VendorOption | null
  selectedApproval: ApprovalRequest | null
  daysLeft: number
  blockers: string[]
  superseded: number
  packageTitle: string
}

export function derive(s: RunSnapshot): Derived {
  const tasks = s.plan?.tasks ?? []
  const activeTasks = tasks.filter((t) => t.status !== 'skipped')
  const done = activeTasks.filter((t) => t.status === 'done').length
  const current = activeTasks.find((t) => t.status === 'running' || t.status === 'waiting_human') ?? null
  const next = activeTasks.find((t) => t.status === 'pending' || t.status === 'ready') ?? null
  const pending = s.approvals.filter((a) => a.status === 'pending')
  const selectedApproval = [...s.approvals].reverse().find((a) => a.kind === 'vendor_selection' && a.status === 'approved') ?? null
  const selected = selectedApproval ? (s.options.find((o) => o.option_id === selectedApproval.decided_option) ?? null) : null
  const recommended = s.options.find((o) => o.recommended) ?? null
  const blockers: string[] = []
  if (s.status === 'killed') blockers.push('Worker process is offline')
  for (const ev of s.events ?? []) {
    if (ev.status === 'pending') blockers.push(`Event ${ev.id} (${ev.type.replace(/_/g, ' ')}) is being processed`)
    if (ev.status === 'applied' && ev.type === 'document_missing') blockers.push(`${ev.vendor_id}: “${String(ev.params.document ?? 'document')}” missing`)
    if (ev.status === 'applied' && ev.type === 'approver_unavailable') blockers.push(`Approver away ${String(ev.params.days ?? '')} d — reminder sent`)
  }
  if (recommended && recommended.budget_verdict === 'breach') blockers.push(`Best option breaches the ${inr(s.goal.budget_inr)} budget`)
  if (s.options.length && !recommended && s.status !== 'completed') blockers.push('No option meets both budget and site date')
  return {
    activeTasks,
    done,
    total: activeTasks.length,
    current,
    next,
    pending,
    pendingApproval: pending[0] ?? null,
    recommended,
    selected,
    selectedApproval,
    daysLeft: daysBetween(s.sim_now, s.goal.need_by),
    blockers,
    superseded: tasks.length - activeTasks.length,
    packageTitle: s.goal.package,
  }
}
