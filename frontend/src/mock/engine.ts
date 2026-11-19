// In-browser simulation of the SiteMind durable worker. Produces RunSnapshots with the exact shapes
// of backend/sitemind/models.py so the UI can be built and demoed without a backend. Generic over
// packages (see ./packages.ts) and supports live event injection (v2).
import type {
  ApprovalDecision,
  ApprovalRequest,
  AuditEntry,
  CreateRunRequest,
  DecisionMemo,
  InjectEventRequest,
  InjectedEvent,
  JsonDict,
  Plan,
  PlanTask,
  PurchaseOrder,
  Quote,
  RunSnapshot,
  TaskStatus,
  TimelineKind,
  VendorOption,
} from '../types'
import { SIM_START } from './scenario'
import { packageById, STORIES, type Story } from './packages'

const IST = 5.5 * 3600_000
const DAY = 86_400_000
const CONTINGENCY = 0.05

export function isoIST(ms: number): string {
  return new Date(ms + IST).toISOString().replace(/\.\d{3}Z$/, '+05:30')
}
const round = (n: number) => Math.round(n)
const clone = <T,>(x: T): T => structuredClone(x)
const cr = (n: number) => `₹${(n / 1e7).toFixed(2)} Cr`
const lakh = (n: number) => `₹${(n / 1e5).toFixed(1)} L`
const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)

export const committedOf = (o: VendorOption) => o.total_inr + (o.total_inr - o.expedite_fee_inr) * CONTINGENCY

function clamp(x: number) {
  return Math.max(0, Math.min(1, x))
}
function score(util: number, float: number, rel: number) {
  return Math.round((0.4 * clamp((1 - util) / 0.25) + 0.35 * clamp(float / 30) + 0.25 * clamp((rel - 0.7) / 0.3)) * 1000) / 1000
}

interface Step {
  node: string
  hours: number
  run: (e: MockEngine) => void
  gate?: ApprovalRequest['kind']
}

let pidSeq = 48211

export class MockEngine {
  snap: RunSnapshot
  story: Story
  private cursor = 0
  private now: number
  private seq = 0
  private evSeq = 0
  private quotesBy: Record<string, Quote> = {}
  private lastLedgerKey: string | null = null
  /** vendors that cannot be awarded (missing document injected) */
  blocked: Record<string, string> = {}
  private memoSeq = 2

  constructor(runId: string, req: CreateRunRequest) {
    this.now = Date.parse(SIM_START)
    const pkg = packageById(req.package_id)
    this.story = STORIES[pkg.package_id]!
    this.snap = {
      run_id: runId,
      goal: {
        text: req.goal_text,
        project: req.project ?? pkg.default_project,
        package: pkg.title,
        need_by: req.need_by,
        required_on_site: pkg.required_on_site,
        budget_inr: req.budget_inr,
        currency: 'INR',
      },
      status: 'running',
      sim_now: isoIST(this.now),
      sim_start: isoIST(this.now),
      plan: null,
      plan_history: [],
      takeoff: null,
      quotes: [],
      vendor_attempts: [],
      options: [],
      schedule: null,
      budget: { budget_inr: req.budget_inr, committed_inr: 0, forecast_inr: 0, spent_process_inr: 0, points: [] },
      approvals: [],
      po: null,
      audit: [],
      ledger: [],
      timeline: [],
      worker: { pid: pidSeq++, alive: true, started_at: isoIST(this.now), restarts: 0 },
      checkpoints: 0,
      current_node: 'planner',
      llm: { provider: 'ollama', model: 'qwen2.5:3b', calls: 0 },
      error: null,
      package_id: pkg.package_id,
      events: [],
    }
  }

  get D() {
    return this.story.data
  }
  get title() {
    return this.snap.goal.package
  }
  get done(): boolean {
    return this.cursor >= STEPS.length
  }
  vname(v: string) {
    return this.story.short[v] ?? v
  }

  /** Advance one super-step. Returns false when blocked / finished / killed. */
  tick(): boolean {
    const s = this.snap
    if (s.status === 'killed' || s.status === 'failed') return false
    this.drainEvents()
    if (s.status === 'completed') return false
    const step = STEPS[this.cursor]
    if (!step) return false
    if (step.gate) {
      const appr = [...s.approvals].reverse().find((a) => a.kind === step.gate)
      if (!appr || appr.status === 'pending') {
        s.status = 'waiting_human'
        return false
      }
    }
    s.status = 'running'
    s.current_node = step.node
    this.now += step.hours * 3600_000
    s.sim_now = isoIST(this.now)
    step.run(this)
    this.cursor++
    s.checkpoints++
    const next = STEPS[this.cursor]
    if (next) s.current_node = next.node
    if (this.done) {
      s.status = 'completed'
      s.current_node = null
    }
    return true
  }

  kill(): void {
    const s = this.snap
    if (s.status === 'completed' || s.status === 'failed') return
    s.status = 'killed'
    s.worker.alive = false
    this.tl('system', `SIGKILL pid ${s.worker.pid}`, 'kill')
    this.audit('system', 'worker.killed', `Worker pid ${s.worker.pid} received SIGKILL at checkpoint #${s.checkpoints}. State is durable in SQLite.`, {
      inputs: { signal: 'SIGKILL', pid: s.worker.pid },
      outputs: { last_checkpoint: s.checkpoints },
    })
  }

  resume(): void {
    const s = this.snap
    if (s.status !== 'killed') return
    s.worker = { pid: pidSeq++, alive: true, started_at: isoIST(this.now), restarts: s.worker.restarts + 1 }
    s.status = 'running'
    this.tl('system', `Resumed from checkpoint #${s.checkpoints}`, 'success')
    this.audit('system', 'worker.resumed', `New worker pid ${s.worker.pid} resumed from checkpoint #${s.checkpoints}; completed side effects replayed from the ledger, not re-executed.`, {
      outputs: { checkpoint: s.checkpoints, restarts: s.worker.restarts },
    })
    if (this.lastLedgerKey) {
      const entry = s.ledger.find((l) => l.idempotency_key === this.lastLedgerKey)
      if (entry) entry.executions += 1
    }
    const step = STEPS[this.cursor]
    if (step?.gate) {
      const appr = [...s.approvals].reverse().find((a) => a.kind === step.gate)
      if (appr?.status === 'pending') s.status = 'waiting_human'
    }
  }

  decide(approvalId: string, d: ApprovalDecision): void {
    const s = this.snap
    const a = s.approvals.find((x) => x.id === approvalId)
    if (!a || a.status !== 'pending') return
    this.now += 20 * 3600_000
    s.sim_now = isoIST(this.now)
    a.status = d.decision === 'approve' ? 'approved' : 'rejected'
    a.decided_option = d.option_id ?? a.memo?.recommendation ?? null
    a.decided_by = d.decided_by ?? 'project.manager@alpha'
    a.comment = d.comment ?? null
    a.decided_at = isoIST(this.now)
    const opt = s.options.find((o) => o.option_id === a.decided_option)
    this.tl('human', a.status === 'approved' ? `Approved: ${a.kind === 'po_release' ? 'PO release' : opt?.vendor_name ?? a.decided_option}` : 'Rejected', 'human')
    this.audit('human', `approval.${a.status}`, `${a.decided_by} ${a.status} “${a.title}”${a.comment ? ` — “${a.comment}”` : ''}.`, {
      inputs: { approval_id: a.id, option_id: a.decided_option },
      outputs: { status: a.status },
      confidence: 1,
    })
    const task = s.plan?.tasks.find((t) => t.status === 'waiting_human')
    if (task) this.task(task.id, a.status === 'approved' ? 'done' : 'failed')
    if (a.status === 'rejected') {
      s.status = 'failed'
      s.error = 'Rejected by approver; agent halted pending new instructions.'
      return
    }
    s.status = 'running'
  }

  // ---------------------------------------------------------------- live events (v2)

  inject(req: InjectEventRequest): InjectedEvent {
    const s = this.snap
    const ev: InjectedEvent = {
      id: `ev-${++this.evSeq}`,
      run_id: s.run_id,
      type: req.type,
      vendor_id: req.vendor_id ?? null,
      params: req.params ?? {},
      note: req.note ?? null,
      status: 'pending',
      received_at: new Date().toISOString(),
      applied_sim_time: null,
      outcome: null,
      triggers: [],
    }
    s.events.push(ev)
    if (s.status === 'completed') {
      ev.status = 'ignored'
      ev.outcome = 'Run already completed — the PO has been sent; event recorded for the audit trail only.'
      ev.applied_sim_time = s.sim_now
    }
    // A parked or killed worker is woken so the event is processed now.
    if (s.status === 'killed') this.resume()
    return ev
  }

  private drainEvents() {
    for (const ev of this.snap.events) if (ev.status === 'pending') this.applyEvent(ev)
  }

  private applyEvent(ev: InjectedEvent) {
    const s = this.snap
    this.now += 2 * 3600_000
    s.sim_now = isoIST(this.now)
    const v = ev.vendor_id ?? ''
    const num = (k: string, d: number) => Number(ev.params[k] ?? d)
    this.ledger(`${s.run_id}:event:${ev.id}:apply`, 'event.apply', { type: ev.type, vendor_id: ev.vendor_id, params: ev.params }, { applied: true })
    this.audit('human', `event.${ev.type}`, `Injected ${ev.type.replace(/_/g, ' ')}${v ? ` on ${v}` : ''}${ev.note ? ` — “${ev.note}”` : ''}.`, { inputs: { event_id: ev.id, ...ev.params } })
    let outcome = ''
    switch (ev.type) {
      case 'price_change': {
        const pct = num('pct', 8)
        const q = this.quotesBy[v]
        if (!q) {
          outcome = `${v} has not quoted yet; the ${pct > 0 ? '+' : ''}${pct} % will be applied to its quote when it arrives.`
          break
        }
        const f = 1 + pct / 100
        const nq: Quote = { ...clone(q), revision: q.revision + 1, status: 'revised', total_inr: round(q.total_inr * f), quote_id: q.quote_id.replace(/-R\d+$/, '') + `-R${q.revision + 1}`, notes: `Revision ${q.revision + 1}: ${pct > 0 ? '+' : ''}${pct} % (injected event ${ev.id}).`, received_at: s.sim_now }
        nq.lines = nq.lines.map((l) => ({ ...l, unit_price_inr: round(l.unit_price_inr * f), total_inr: round(l.total_inr * f) }))
        this.setQuote(nq)
        s.vendor_attempts.push({ vendor_id: v, attempt: q.revision + 1, outcome: 'revised', at: s.sim_now, detail: `${nq.quote_id}: INR ${q.total_inr.toLocaleString('en-IN')} -> ${nq.total_inr.toLocaleString('en-IN')} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%). Injected event` })
        s.options = s.options.map((o) => (o.vendor_id === v ? { ...o, total_inr: round((o.total_inr - o.expedite_fee_inr) * f + o.expedite_fee_inr) } : o))
        this.tl('quotes', `${v} revised ${pct > 0 ? '+' : ''}${pct} %`, pct > 0 ? 'warning' : 'success')
        outcome = this.rerank(ev, `${this.vname(v)} price ${pct > 0 ? '+' : ''}${pct} %`)
        ev.triggers.push(`price_change:${v}`)
        break
      }
      case 'vendor_late_reply': {
        const days = num('days', 3)
        this.tl('quotes', `${v} reply +${days} d`, 'warning')
        outcome =
          this.quotesBy[v] && this.quotesBy[v]!.revision >= 1 && this.cursor > 5
            ? `${this.vname(v)}'s next reply now expected ${days} d later; no open RFQ depends on it, so the plan is unchanged and a chase is scheduled.`
            : `${this.vname(v)}'s reply pushed ${days} d; scheduled a chase and kept the other vendors moving in parallel.`
        this.ledger(`${s.run_id}:event:${ev.id}:chase:${v}`, 'vendor.chase', { vendor: v }, { sent: true })
        break
      }
      case 'date_slip': {
        const days = num('days', 21)
        const target = String(ev.params.target ?? 'lead_time')
        if (target === 'required_on_site') {
          s.goal.required_on_site = addDays(s.goal.required_on_site ?? '2027-07-30', days)
          s.options = s.options.map((o) => this.withFloat(o, o.float_days + days))
          this.tl('schedule', `Site date ${days > 0 ? '+' : ''}${days} d`, 'warning')
          outcome = this.rerank(ev, `required-on-site moved ${days > 0 ? '+' : ''}${days} d`)
        } else {
          s.options = s.options.map((o) => (o.vendor_id === v ? { ...this.withFloat(o, o.float_days - days), lead_time_days: o.lead_time_days + days, delivery_date: addDays(o.delivery_date, days) } : o))
          this.tl('schedule', `${v} lead time +${days} d`, 'warning')
          outcome = this.rerank(ev, `${this.vname(v)} lead time +${days} d`)
        }
        ev.triggers.push(`date_slip:${target}`)
        break
      }
      case 'document_missing': {
        const doc = String(ev.params.document ?? 'Type-test certificate')
        this.blocked[v] = doc
        this.tl('quotes', `${v} missing: ${doc}`, 'warning')
        this.ledger(`${s.run_id}:event:${ev.id}:chase-doc:${v}`, 'vendor.chase', { vendor: v, document: doc }, { sent: true })
        outcome = this.rerank(ev, `${this.vname(v)} cannot be awarded until “${doc}” arrives (chase sent)`)
        ev.triggers.push(`document_missing:${v}`)
        break
      }
      case 'tool_failure': {
        const tool = String(ev.params.tool ?? 'quotes')
        const count = num('count', 2)
        this.now += count * 2 * 3600_000
        s.sim_now = isoIST(this.now)
        this.tl('system', `${tool} failed ×${count}, retried`, 'warning')
        this.audit(tool, 'tool.retry', `${tool} raised ${count}× (injected); retried with exponential backoff (${count * 2} sim h) and succeeded on attempt ${count + 1}.`, { outputs: { failures: count, attempts: count + 1 }, confidence: 0.9 })
        outcome = `The next ${count} ${tool} call${count > 1 ? 's' : ''} failed; the agent retried with backoff and succeeded on attempt ${count + 1} — no data lost, ${count * 2} sim h added.`
        break
      }
      case 'approver_unavailable': {
        const days = num('days', 3)
        this.now += days * DAY
        s.sim_now = isoIST(this.now)
        this.ledger(`${s.run_id}:event:${ev.id}:reminder`, 'notify.pm', { to: 'deputy.pm@alpha', days }, { sent: true })
        this.tl('approvals', `Approver away ${days} d — reminder sent`, 'human')
        outcome = `Approver away for ${days} d: sent a reminder and a delegation note to the deputy PM; the agent waits rather than deciding alone.`
        break
      }
      case 'restart': {
        this.kill()
        this.resume()
        outcome = `Worker SIGKILLed and resumed from checkpoint #${s.checkpoints}; side effects replayed from the ledger, none repeated.`
        break
      }
    }
    ev.status = 'applied'
    ev.applied_sim_time = s.sim_now
    ev.outcome = outcome
    this.audit(ev.type === 'tool_failure' ? 'system' : 'planner', 'event.reaction', outcome, { inputs: { event_id: ev.id }, outputs: { triggers: ev.triggers }, confidence: 0.85 })
  }

  private withFloat(o: VendorOption, float: number): VendorOption {
    return { ...o, float_days: float, meets_deadline: float >= 0 }
  }

  /** Re-score + re-rank options; supersede a pending vendor-selection approval if the recommendation changed or was invalidated. */
  private rerank(ev: InjectedEvent, what: string): string {
    const s = this.snap
    if (!s.options.length) return `Noted: ${what}. No options ranked yet; it will be used when the vendors are evaluated.`
    const budget = s.goal.budget_inr
    const beforeOpt = s.options.find((o) => o.recommended)
    const before = beforeOpt?.option_id
    const affectsRec = (!!ev.vendor_id && ev.vendor_id === beforeOpt?.vendor_id) || ev.params.target === 'required_on_site'
    let opts = s.options.map((o) => {
      const u = committedOf(o) / budget
      const verdict = u > 1 ? 'breach' : u >= 0.9 ? 'warn' : 'ok'
      return { ...o, budget_verdict: verdict as VendorOption['budget_verdict'], score: score(u, o.float_days, o.reliability), recommended: false }
    })
    const feasible = (o: VendorOption) => o.budget_verdict !== 'breach' && o.meets_deadline && !this.blocked[o.vendor_id]
    opts = [...opts.filter(feasible).sort((a, b) => b.score - a.score), ...opts.filter((o) => !feasible(o)).sort((a, b) => b.score - a.score)]
    if (opts[0] && feasible(opts[0])) opts[0].recommended = true
    s.options = opts
    const rec = opts.find((o) => o.recommended)
    const best = rec ? committedOf(rec) : committedOf(opts[0]!)
    this.point(best)
    const pending = s.approvals.find((a) => a.kind === 'vendor_selection' && a.status === 'pending')
    const changed = rec?.option_id !== before
    const recLabel = rec ? `${rec.option_id} ${this.vname(rec.vendor_id)}` : 'no feasible option'
    if (pending && (changed || affectsRec)) {
      pending.status = 'rejected'
      pending.decided_by = `system: superseded by ${ev.id}`
      pending.decided_at = s.sim_now
      pending.comment = `Memo invalidated: ${what}.`
      this.tl('approvals', 'Approval superseded', 'warning')
      this.replanAfter(ev, what)
      this.requestVendorApproval(`${what}. The previous memo was superseded; options re-levelled and re-ranked.`)
      ev.triggers.push('approval_superseded')
      return `${what}: the pending approval was superseded, the plan re-ranked and a fresh memo ${changed ? 'now recommends' : 'still recommends'} ${recLabel}.`
    }
    if (changed) return `${what}: re-levelled, re-ranked — recommendation is now ${recLabel}.`
    return `${what}: re-levelled and re-ranked — ${recLabel} still leads (forecast ${cr(best)}, ${pct1(best / budget)} of budget).`
  }

  private replanAfter(ev: InjectedEvent, what: string) {
    const s = this.snap
    const prev = s.plan!
    const v = prev.version + 1
    const tasks = prev.tasks.map((x) => (x.status === 'waiting_human' ? { ...x, status: 'skipped' as TaskStatus, note: `Superseded by plan v${v} (${ev.id})` } : { ...x }))
    const pendingIds = tasks.filter((x) => x.status === 'pending').map((x) => x.id)
    const tail = tasks.filter((x) => pendingIds.includes(x.id))
    const kept = tasks.filter((x) => !pendingIds.includes(x.id))
    const lastDone = [...kept].reverse().find((x) => x.status === 'done')?.id
    const ra = `E${v}-rerank`
    const ap = `E${v}-approve-vendor`
    const newTasks = [
      t(ra, `Re-rank after ${ev.type.replace(/_/g, ' ')}`, 'approvals', lastDone ? [lastDone] : [], v),
      t(ap, 'Approve vendor', 'approvals', [ra], v),
    ]
    // re-wire the remaining tail (draft PO ...) after the new approval
    const rewired = tail.map((x, i) => (i === 0 ? { ...x, depends_on: [ap] } : x))
    s.plan = { ...prev, version: v, created_at: s.sim_now, rationale: `Event ${ev.id}: ${what}. Re-rank the options and ask the PM again with a fresh memo; downstream tasks wait for the new approval.`, tasks: [...kept, ...newTasks, ...rewired] }
    s.plan_history.push(clone(s.plan))
    this.task(ra, 'running')
    this.finish(ra)
    this.tl('planner', `Re-plan v${v} · ${ev.type.replace(/_/g, ' ')}`, 'warning')
    this.audit('planner', 'replan', `Re-planned (v${v}): +2 tasks, 1 superseded. Trigger: ${what}.`, { inputs: { trigger: ev.type, event_id: ev.id }, outputs: { version: v, added: 2, superseded: 1 }, llm_tokens: 900, confidence: 0.82, task_id: 'plan' })
  }

  requestVendorApproval(situation: string, memoIn?: DecisionMemo): void {
    const s = this.snap
    const rec = s.options.find((o) => o.recommended)
    const memo: DecisionMemo = memoIn ?? this.buildMemo(situation)
    const n = this.memoSeq++
    const id = `${s.run_id}:vendor-selection:m${n}`
    const feasible = memo.options.filter((o) => o.budget_verdict !== 'breach' && o.meets_deadline && !this.blocked[o.vendor_id]).map((o) => o.option_id)
    this.ledger(`${s.run_id}:approve-vendor:approval.requested:m${n}`, 'approval.requested', { approval_id: id }, { status: 'pending' })
    s.approvals.push({
      id,
      run_id: s.run_id,
      kind: 'vendor_selection',
      title: `Select ${this.title} vendor`,
      summary: rec ? `Recommend ${rec.vendor_name} (${cr(rec.total_inr)} ex-GST, ${rec.float_days >= 0 ? '+' : ''}${rec.float_days} d float). ${situation}` : situation,
      memo,
      po: null,
      options: feasible,
      status: 'pending',
      decided_option: null,
      decided_by: null,
      comment: null,
      requested_at: s.sim_now,
      decided_at: null,
    })
    const wt = s.plan?.tasks.find((x) => x.status === 'pending' && x.title === 'Approve vendor') ?? [...(s.plan?.tasks ?? [])].reverse().find((x) => x.title === 'Approve vendor' && x.status !== 'skipped' && x.status !== 'done')
    if (wt) this.task(wt.id, 'waiting_human')
    this.tl('approvals', 'Decision memo → PM', 'human')
    this.audit('approvals', 'approval.requested', `Decision memo ${memo.memo_id} sent to the project manager; recommending ${memo.recommendation}.`, { outputs: { recommendation: memo.recommendation, options: feasible }, llm_tokens: 1800, confidence: 0.83 })
  }

  buildMemo(situation: string): DecisionMemo {
    const s = this.snap
    const opts = clone(s.options)
    const rec = opts.find((o) => o.recommended) ?? opts[0]!
    const others = opts.filter((o) => o !== rec)
    const fmtO = (o: VendorOption) => `${o.option_id} (${o.vendor_name}): ${cr(o.total_inr)}, ${pct1(committedOf(o) / s.goal.budget_inr)} of budget (${o.budget_verdict}), ${o.float_days >= 0 ? '+' : ''}${o.float_days} d float, ${Math.round(o.reliability * 100)} % on-time`
    return {
      memo_id: `MEMO-${s.package_id.toUpperCase()}-${String(this.memoSeq).padStart(4, '0')}`,
      title: `${s.goal.project} - ${this.title}: vendor selection`,
      situation,
      options: opts,
      recommendation: rec.option_id,
      reasoning: `Recommend ${fmtO(rec)}, score ${rec.score.toFixed(2)}. ${others.map((o) => `${o.recommended ? '' : 'Versus '}${fmtO(o)}${this.blocked[o.vendor_id] ? ` — blocked: ${this.blocked[o.vendor_id]} missing` : o.budget_verdict === 'breach' ? ' — infeasible: over budget' : !o.meets_deadline ? ' — infeasible: late' : ''}.`).join(' ')}`,
      risks: [
        `${rec.option_id}: ${rec.float_days < 14 ? `only ${rec.float_days} d of float — weekly expediting needed.` : 'float is comfortable; keep fortnightly progress reports.'}`,
        `${rec.option_id}: on-time record ${Math.round(rec.reliability * 100)} %; tie payment milestones to delivery and LDs.`,
        'Quotes can move again before PO release; the agent re-confirms prices at PO draft.',
      ],
      asks: `Approve vendor selection for ${s.goal.project} ${this.title}: confirm ${rec.option_id} or pick another feasible option.`,
    }
  }

  // ---------------------------------------------------------------- helpers used by steps

  tl(lane: string, label: string, kind: TimelineKind = 'info'): void {
    this.snap.timeline.push({ sim_time: isoIST(this.now), lane, label, kind })
  }

  audit(
    actor: string,
    action: string,
    summary: string,
    extra: Partial<Pick<AuditEntry, 'inputs' | 'outputs' | 'cost_inr' | 'llm_tokens' | 'confidence' | 'task_id'>> = {},
  ): void {
    const s = this.snap
    s.audit.push({
      seq: ++this.seq,
      run_id: s.run_id,
      sim_time: isoIST(this.now),
      wall_time: new Date().toISOString(),
      actor,
      action,
      summary,
      inputs: extra.inputs ?? {},
      outputs: extra.outputs ?? {},
      cost_inr: extra.cost_inr ?? 0,
      llm_tokens: extra.llm_tokens ?? 0,
      confidence: extra.confidence ?? null,
      task_id: extra.task_id ?? null,
      plan_version: s.plan?.version ?? null,
    })
    if (extra.llm_tokens) {
      s.llm.calls = (s.llm.calls ?? 0) + 1
      s.budget.spent_process_inr += Math.round(extra.llm_tokens * 0.002)
      this.ledger(`${s.run_id}:${extra.task_id ?? 'run'}:llm.call:${action}:${this.seq}`, 'llm.call', { action }, { tokens: extra.llm_tokens })
    }
  }

  ledger(key: string, kind: string, payload: JsonDict, result: JsonDict): void {
    const s = this.snap
    const existing = s.ledger.find((l) => l.idempotency_key === key)
    if (existing) {
      existing.executions++
      return
    }
    s.ledger.push({ idempotency_key: key, run_id: s.run_id, kind, status: 'done', payload, result, sim_time: isoIST(this.now), wall_time: new Date().toISOString(), executions: 1 })
    this.lastLedgerKey = key
  }

  task(id: string, status: TaskStatus, note?: string): void {
    const tk = this.snap.plan?.tasks.find((x) => x.id === id)
    if (!tk) return
    if (status === 'running' || status === 'waiting_human') tk.started_at ??= isoIST(this.now)
    if (status === 'done' || status === 'failed') {
      tk.started_at ??= isoIST(this.now)
      tk.finished_at = isoIST(this.now)
    }
    if (status === 'running') tk.attempts++
    tk.status = status
    if (note) tk.note = note
  }

  finish(id: string, next: string[] = [], note?: string): void {
    this.task(id, 'done', note)
    next.forEach((n) => this.task(n, 'running'))
  }

  point(forecast: number, committed = this.snap.budget.committed_inr): void {
    const b = this.snap.budget
    b.forecast_inr = round(forecast)
    b.committed_inr = round(committed)
    b.points.push({ sim_time: isoIST(this.now), committed_inr: b.committed_inr, forecast_inr: b.forecast_inr })
  }

  get quotes() {
    return this.quotesBy
  }
  setQuote(q: Quote) {
    this.quotesBy[q.vendor_id] = q
    this.snap.quotes = Object.keys(this.story.short).map((v) => this.quotesBy[v]).filter((x): x is Quote => !!x)
  }
  get simNow() {
    return this.now
  }
}

// --------------------------------------------------------------------------- plan definitions

function t(id: string, title: string, specialist: string, deps: string[], v: number, extra: Partial<PlanTask> = {}): PlanTask {
  return { id, title, specialist, depends_on: deps, deadline: null, budget_inr: 0, status: 'pending', attempts: 0, plan_version: v, started_at: null, finished_at: null, output_ref: null, note: null, ...extra }
}

function planV1(e: MockEngine, now: string): Plan {
  const n = Object.keys(e.story.short).length
  return {
    version: 1,
    created_at: now,
    rationale: `Decompose the ordering goal into takeoff → parallel RFQs → schedule & budget checks → evaluation → two human gates (vendor selection, PO release) → idempotent PO dispatch. Work back from the ${e.story.rosLabel}: the PO must issue by ${e.snap.goal.need_by}.`,
    risks: [
      { id: 'R1', title: 'Vendor non-response or incomplete submittals delay comparison', likelihood: 'medium', impact: 'medium', mitigation: 'Retry with backoff (max 3 attempts); chase missing documents.' },
      { id: 'R2', title: 'Commodity / forex volatility revises quotes', likelihood: 'medium', impact: 'high', mitigation: 'Refresh quotes before the memo; keep 5 % contingency.' },
      { id: 'R3', title: 'Long lead time misses the site date', likelihood: 'medium', impact: 'high', mitigation: 'CPM float check per vendor; evaluate expedite / alternates.' },
    ],
    tasks: [
      t('T1-takeoff', `Take off ${e.title} spec`, 'takeoff', [], 1, { deadline: '2027-01-13' }),
      t('T2-rfq', `RFQ to ${n} vendors`, 'quotes', ['T1-takeoff'], 1, { deadline: '2027-01-20' }),
      t('T3-schedule', 'CPM schedule check', 'schedule', ['T2-rfq'], 1),
      t('T4-budget', 'Budget check', 'budget', ['T2-rfq'], 1),
      t('T5-evaluate', 'Refresh & rank quotes', 'approvals', ['T3-schedule', 'T4-budget'], 1),
      t('T6-approve-vendor', 'Approve vendor', 'approvals', ['T5-evaluate'], 1),
      t('T7-draft-po', 'Draft PO', 'po', ['T6-approve-vendor'], 1),
      t('T8-approve-po', 'Approve PO release', 'approvals', ['T7-draft-po'], 1),
      t('T9-send-po', 'Send PO', 'po', ['T8-approve-po'], 1, { deadline: e.snap.goal.need_by }),
    ],
  }
}

function planV2(e: MockEngine, prev: Plan, now: string): Plan {
  const st = e.story
  const rv = st.revise.vendor
  const keep = prev.tasks.map((x) =>
    ['T6-approve-vendor', 'T7-draft-po', 'T8-approve-po', 'T9-send-po'].includes(x.id) ? { ...x, status: 'skipped' as TaskStatus, note: 'Superseded by plan v2 (price revision)' } : { ...x },
  )
  const altTitle = st.alt.kind === 'expedite' ? `Price ${st.alt.vendor} expedite` : st.docMissing ? `Chase ${st.docMissing.vendor} certificate` : 'Re-check lead times'
  return {
    version: 2,
    created_at: now,
    rationale: `${e.vname(rv)} (${rv}) revised its quote on refresh (${st.revise.reason}), pushing committed cost over budget. Re-plan: try re-negotiation with ${rv}, ${st.alt.kind === 'expedite' ? `price the ${st.alt.vendor} expedite` : `chase the missing ${st.docMissing?.doc ?? 'documents'} and re-confirm lead times`}, re-run the budget across all options, then put a decision memo to the PM.`,
    risks: [...prev.risks, { id: 'R4', title: 'Recommended option has thin margins', likelihood: 'medium', impact: 'medium', mitigation: 'Tie fees to milestones; LDs 0.5 %/week capped at 10 %.' }],
    tasks: [
      ...keep,
      t('R1-renegotiate', `Re-negotiate ${rv} price`, 'quotes', ['T5-evaluate'], 2),
      t('R2-alternate', altTitle, 'schedule', ['T5-evaluate'], 2),
      t('R3-rebudget', 'Re-check budget', 'budget', ['R1-renegotiate', 'R2-alternate'], 2),
      t('R4-memo', 'Decision memo', 'approvals', ['R3-rebudget'], 2),
      t('R5-approve-vendor', 'Approve vendor', 'approvals', ['R4-memo'], 2),
      t('R6-draft-po', 'Draft PO', 'po', ['R5-approve-vendor'], 2),
      t('R7-approve-po', 'Approve PO release', 'approvals', ['R6-draft-po'], 2),
      t('R8-send-po', 'Send PO', 'po', ['R7-approve-po'], 2, { deadline: e.snap.goal.need_by }),
    ],
  }
}

const q1 = (e: MockEngine, v: string) => e.D.quotes_r1.find((q) => q.vendor_id === v)!
const optById = (list: VendorOption[], id: string) => list.find((o) => o.option_id === id)!

function draftPO(e: MockEngine, opt: VendorOption): PurchaseOrder {
  const s = e.snap
  const q = e.quotes[opt.vendor_id]!
  const pre = e.D.pos[opt.option_id]
  if (pre && pre.subtotal_inr === q.lines.reduce((a, l) => a + l.total_inr, 0)) return clone(pre)
  // Generic PO (used when an injected event changed the price or picked another option).
  const lines = q.lines.map((l, i) => {
    const tl = e.D.takeoff.lines.find((x) => x.item_code === l.item_code)
    return { line_no: i + 1, item_code: l.item_code, description: `${tl?.description ?? l.item_code}${tl?.rating ? ` (${tl.rating})` : ''}`, qty: l.qty, unit_price_inr: l.unit_price_inr, total_inr: l.total_inr }
  })
  const subtotal = lines.reduce((a, l) => a + l.total_inr, 0)
  const gst = round((subtotal + q.freight_inr + opt.expedite_fee_inr) * 0.18)
  const total = subtotal + q.freight_inr + opt.expedite_fee_inr + gst
  const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2 })
  const md = [
    `# Purchase Order ${e.story.poNumber}`,
    '',
    `**Project:** ${s.goal.project} - ${e.title}  `,
    '**Status:** DRAFT  ',
    `**Contractual delivery:** ${opt.delivery_date}  `,
    `**Vendor quote:** ${q.quote_id} (rev ${q.revision})`,
    '',
    '## Lines',
    '',
    '| # | Item code | Description | Qty | Unit price (INR) | Amount (INR) |',
    '|---:|---|---|---:|---:|---:|',
    ...lines.map((l) => `| ${l.line_no} | \`${l.item_code}\` | ${l.description} | ${l.qty} | ${inr(l.unit_price_inr)} | ${inr(l.total_inr)} |`),
    '',
    '## Totals',
    '',
    '| | Amount (INR) |',
    '|---|---:|',
    `| Subtotal | ${inr(subtotal)} |`,
    `| Freight | ${inr(q.freight_inr)} |`,
    `| Expedite fee | ${inr(opt.expedite_fee_inr)} |`,
    `| GST 18 % | ${inr(gst)} |`,
    `| **Total payable** | **${inr(total)}** |`,
  ].join('\n')
  return {
    po_number: e.story.poNumber,
    vendor_id: opt.vendor_id,
    vendor_name: q.vendor_name,
    project: s.goal.project,
    lines,
    subtotal_inr: subtotal,
    freight_inr: q.freight_inr,
    expedite_fee_inr: opt.expedite_fee_inr,
    gst_inr: gst,
    total_inr: total,
    delivery_date: opt.delivery_date,
    payment_terms: '10% advance against ABG, 80% on delivery, 10% after commissioning',
    incoterms: 'DAP Project Alpha site, Chakan MIDC (Incoterms 2020)',
    terms: ['LDs 0.5 %/week capped at 10 %', '24-month warranty'],
    status: 'draft',
    issued_at: null,
    markdown: md,
  }
}

// --------------------------------------------------------------------------- the script

const STEPS: Step[] = [
  {
    node: 'planner',
    hours: 0.5,
    run: (e) => {
      const s = e.snap
      s.plan = planV1(e, s.sim_now)
      s.plan_history = [clone(s.plan)]
      e.task('T1-takeoff', 'running')
      e.tl('planner', 'Plan v1 · 9 tasks', 'info')
      e.audit('planner', 'plan.created', `Built a 9-task plan working back from the ${e.story.rosLabel}; the PO must be issued by ${s.goal.need_by} within ${cr(s.goal.budget_inr)}.`, {
        inputs: { goal: s.goal.text },
        outputs: { tasks: 9, risks: 3 },
        llm_tokens: 1240,
        confidence: 0.86,
        task_id: 'plan',
      })
      e.point(s.goal.budget_inr * 0.91)
    },
  },
  {
    node: 'takeoff',
    hours: 2,
    run: (e) => {
      const s = e.snap
      const tk = e.D.takeoff
      s.takeoff = clone(tk)
      e.finish('T1-takeoff', ['T2-rfq'])
      e.tl('takeoff', `${tk.lines.length} lines · ${Math.round(tk.confidence * 100)} %`, 'success')
      if (tk.warnings.length) e.tl('takeoff', 'RFI raised', 'warning')
      e.audit('takeoff', 'takeoff.completed', `Extracted ${tk.lines.length} BOQ lines from ${tk.document}, each cited to its page and table. ${tk.warnings[0] ?? ''}`, {
        inputs: { pdf: tk.document },
        outputs: { lines: tk.lines.length, confidence: tk.confidence, warnings: tk.warnings },
        confidence: tk.confidence,
        task_id: 'T1-takeoff',
      })
    },
  },
  {
    node: 'quotes',
    hours: 0.5,
    run: (e) => {
      const s = e.snap
      const vs = Object.keys(e.story.short)
      for (const v of vs) e.ledger(`${s.run_id}:T2-rfq:rfq.sent:${v}:1`, 'rfq.sent', { vendor: v, lines: e.D.takeoff.lines.length, attempt: 1 }, { message_id: `rfq-${v.toLowerCase()}-0111` })
      e.tl('quotes', `RFQ → ${vs.join(' · ')}`, 'info')
      e.audit('quotes', 'rfq.sent', `Issued RFQ for ${e.D.takeoff.lines.length} lines to ${vs.map((v) => e.vname(v)).join(', ')}; 24 h response window, max 3 attempts.`, { inputs: { vendors: vs }, task_id: 'T2-rfq' })
    },
  },
  {
    node: 'quotes',
    hours: 24,
    run: (e) => {
      const s = e.snap
      for (const v of Object.keys(e.story.short)) {
        if ((e.story.timeouts[v] ?? 0) >= 1) {
          s.vendor_attempts.push({ vendor_id: v, attempt: 1, outcome: 'timeout', at: s.sim_now, detail: 'No response within 24 h' })
          e.tl('quotes', `${v} timeout #1`, 'warning')
          e.audit('quotes', 'quote.timeout', `${e.vname(v)} (${v}) did not answer within 24 h; retry 2/3 scheduled.`, { inputs: { vendor: v, attempt: 1 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
          e.ledger(`${s.run_id}:T2-rfq:rfq.sent:${v}:2`, 'rfq.sent', { vendor: v, attempt: 2 }, { message_id: `rfq-${v.toLowerCase()}-0112` })
        } else {
          e.setQuote({ ...clone(q1(e, v)), received_at: s.sim_now })
          s.vendor_attempts.push({ vendor_id: v, attempt: 1, outcome: 'ok', at: s.sim_now, detail: `${q1(e, v).quote_id} received` })
          e.tl('quotes', `${v} quoted`, 'success')
          if (e.story.docMissing?.vendor === v) {
            e.tl('quotes', `${v}: ${e.story.docMissing.doc} missing`, 'warning')
            e.audit('quotes', 'document.missing', `${e.vname(v)}'s quote arrived without the ${e.story.docMissing.doc}; it cannot be awarded until received. Chase sent.`, { inputs: { vendor: v }, task_id: 'T2-rfq' })
            e.ledger(`${s.run_id}:T2-rfq:chase-doc:${v}`, 'vendor.chase', { vendor: v, document: e.story.docMissing.doc }, { sent: true })
          }
        }
      }
    },
  },
  {
    node: 'quotes',
    hours: 24,
    run: (e) => {
      const s = e.snap
      let any = false
      for (const [v, n] of Object.entries(e.story.timeouts)) {
        if (n >= 2) {
          any = true
          s.vendor_attempts.push({ vendor_id: v, attempt: 2, outcome: 'timeout', at: s.sim_now, detail: 'No response within 24 h' })
          e.tl('quotes', `${v} timeout #2`, 'warning')
          e.audit('quotes', 'quote.timeout', `${e.vname(v)} (${v}) timed out again; escalating to the regional sales contact for attempt 3/3.`, { inputs: { vendor: v, attempt: 2 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
          e.ledger(`${s.run_id}:T2-rfq:rfq.sent:${v}:3`, 'rfq.sent', { vendor: v, attempt: 3 }, { message_id: `rfq-${v.toLowerCase()}-0113` })
        }
      }
      if (!any) e.audit('quotes', 'quote.clarified', 'Technical clarifications exchanged with all bidders; quotes levelled to the takeoff.', { task_id: 'T2-rfq', confidence: 0.9 })
    },
  },
  {
    node: 'quotes',
    hours: 30,
    run: (e) => {
      const s = e.snap
      for (const [v, n] of Object.entries(e.story.timeouts)) {
        if (n >= 1) {
          e.setQuote({ ...clone(q1(e, v)), received_at: s.sim_now })
          s.vendor_attempts.push({ vendor_id: v, attempt: n + 1, outcome: 'ok', at: s.sim_now, detail: `${q1(e, v).quote_id} received` })
          e.tl('quotes', `${v} quoted (attempt ${n + 1})`, 'success')
        }
      }
      e.finish('T2-rfq', ['T3-schedule', 'T4-budget'])
      e.audit('quotes', 'quote.received', `All quotes in (ex-GST): ${Object.keys(e.story.short).map((v) => `${e.vname(v)} ${cr(q1(e, v).total_inr)}`).join(', ')}.`, {
        outputs: Object.fromEntries(Object.keys(e.story.short).map((v) => [v, q1(e, v).total_inr])),
        task_id: 'T2-rfq',
        confidence: 0.97,
      })
    },
  },
  {
    node: 'schedule',
    hours: 3,
    run: (e) => {
      const s = e.snap
      s.options = clone(e.D.options_initial).map((o) => ({ ...o, recommended: false }))
      const firstV = Object.keys(e.D.schedules)[0]!
      s.schedule = clone(e.D.schedules[firstV] ?? null)
      e.finish('T3-schedule')
      const late = s.options.filter((o) => !o.meets_deadline)
      if (late[0]) e.tl('schedule', `${late[0].vendor_id} late by ${-late[0].float_days} d`, 'error')
      else e.tl('schedule', 'All vendors meet the site date', 'success')
      e.audit('schedule', 'schedule.cpm', `CPM per option: ${s.options.map((o) => `${o.option_id} ${o.float_days >= 0 ? '+' : ''}${o.float_days} d`).join(', ')}.`, {
        outputs: Object.fromEntries(s.options.map((o) => [o.option_id, o.float_days])),
        task_id: 'T3-schedule',
        confidence: 0.92,
      })
    },
  },
  {
    node: 'budget',
    hours: 12,
    run: (e) => {
      const s = e.snap
      s.options = clone(e.D.options_initial)
      e.finish('T4-budget', ['T5-evaluate'])
      const rec = s.options.find((o) => o.recommended)!
      const u = committedOf(rec) / s.goal.budget_inr
      e.tl('budget', `${rec.vendor_id} best · ${Math.round(u * 100)} %`, 'success')
      e.audit('budget', 'budget.checked', `${e.vname(rec.vendor_id)} leads (score ${rec.score.toFixed(3)}): committed ${cr(committedOf(rec))} incl. 5 % contingency = ${pct1(u)} of budget.`, {
        outputs: { forecast: committedOf(rec), recommended: rec.option_id },
        task_id: 'T4-budget',
        confidence: 0.9,
      })
      e.point(committedOf(rec))
    },
  },
  {
    node: 'quotes',
    hours: 48,
    run: (e) => {
      const s = e.snap
      const rv = e.story.revise.vendor
      const rev = e.D.quotes_refreshed.find((q) => q.vendor_id === rv)!
      e.setQuote({ ...clone(rev), received_at: s.sim_now })
      const ra = e.D.attempts_refresh.find((a) => a.vendor_id === rv)!
      s.vendor_attempts.push({ ...ra, at: s.sim_now })
      const o2 = optById(e.D.options_replan, `O-${rv}`)
      s.options = s.options.map((o) => (o.option_id === `O-${rv}` ? { ...clone(o2), recommended: false } : o))
      const pct = (rev.total_inr / q1(e, rv).total_inr - 1) * 100
      e.ledger(`${s.run_id}:T5-evaluate:quote.refresh:${rv}`, 'quote.refresh', { vendor: rv }, { quote_id: rev.quote_id, revision: rev.revision })
      e.finish('T5-evaluate', [], `${rv} revised +${pct.toFixed(1)} % → budget breach`)
      e.tl('quotes', `${rv} revised +${pct.toFixed(1)} %`, 'error')
      e.tl('budget', `Forecast ${pct1(committedOf(o2) / s.goal.budget_inr)} — breach`, 'error')
      e.audit('budget', 'budget.breach', `Quote refresh before award: ${e.vname(rv)} rev ${rev.revision} ${cr(q1(e, rv).total_inr)} → ${cr(rev.total_inr)} (${e.story.revise.reason}). Committed ${cr(committedOf(o2))} exceeds the ${cr(s.goal.budget_inr)} ceiling by ${lakh(committedOf(o2) - s.goal.budget_inr)}.`, {
        inputs: { vendor: rv, revision: rev.revision },
        outputs: { committed: committedOf(o2), verdict: 'breach' },
        task_id: 'T5-evaluate',
        confidence: 0.99,
      })
      e.point(committedOf(o2))
    },
  },
  {
    node: 'planner',
    hours: 2,
    run: (e) => {
      const s = e.snap
      s.plan = planV2(e, s.plan!, s.sim_now)
      s.plan_history.push(clone(s.plan))
      e.task('R1-renegotiate', 'running')
      e.task('R2-alternate', 'running')
      e.tl('planner', 'Re-plan v2 · price revision', 'warning')
      e.audit('planner', 'replan', `Re-planned (v2): +8 tasks, 4 superseded. Trigger: ${e.vname(e.story.revise.vendor)} price revision breached budget.`, {
        inputs: { trigger: 'price_revision', vendor: e.story.revise.vendor },
        outputs: { version: 2, added: 8, superseded: 4 },
        llm_tokens: 1860,
        confidence: 0.81,
        task_id: 'plan',
      })
    },
  },
  {
    node: 'quotes',
    hours: 20,
    run: (e) => {
      const s = e.snap
      const rv = e.story.revise.vendor
      e.ledger(`${s.run_id}:R1-renegotiate:negotiation.sent:${rv}`, 'negotiation.sent', { vendor: rv, target_inr: q1(e, rv).total_inr }, { reply: 'declined' })
      s.vendor_attempts.push({ vendor_id: rv, attempt: 3, outcome: 'declined', at: s.sim_now, detail: 'Will not hold the original price' })
      e.finish('R1-renegotiate')
      e.tl('quotes', `${rv} declines to hold price`, 'warning')
      e.audit('quotes', 'negotiation.declined', `${e.vname(rv)} declined to hold the original price; the increase is passed through under its price-variation clause.`, { inputs: { vendor: rv }, outputs: { reply: 'declined' }, task_id: 'R1-renegotiate', llm_tokens: 640, confidence: 0.88 })
    },
  },
  {
    node: 'schedule',
    hours: 3,
    run: (e) => {
      const s = e.snap
      const alt = e.story.alt
      if (alt.kind === 'expedite') {
        const x = e.D.expedite[alt.vendor]!
        const ox = optById(e.D.options_replan, `O-${alt.vendor}X`)
        e.ledger(`${s.run_id}:R2-alternate:expedite.requested:${alt.vendor}`, 'expedite.requested', { vendor: alt.vendor, days: x.days_saved }, { fee_inr: x.fee_inr })
        e.tl('schedule', `${alt.vendor} expedite −${x.days_saved} d`, 'success')
        e.audit('schedule', 'expedite.priced', `${e.vname(alt.vendor)} confirms −${x.days_saved} d expedite for ${lakh(x.fee_inr)}: delivery ${ox.delivery_date}, float +${ox.float_days} d.`, { outputs: { fee_inr: x.fee_inr, float_days: ox.float_days }, task_id: 'R2-alternate', confidence: 0.9 })
      } else {
        const dm = e.story.docMissing
        if (dm) {
          e.ledger(`${s.run_id}:R2-alternate:chase-doc:${dm.vendor}:2`, 'vendor.chase', { vendor: dm.vendor, document: dm.doc }, { received: true })
          e.tl('quotes', `${dm.vendor}: ${dm.doc} received`, 'success')
          e.audit('quotes', 'document.received', `${e.vname(dm.vendor)} supplied the ${dm.doc} after the chase; the option is now awardable.`, { task_id: 'R2-alternate', confidence: 0.95 })
        }
        const slipped = e.D.quotes_refreshed.find((q) => q.vendor_id === alt.vendor)
        if (slipped) e.setQuote({ ...clone(slipped), received_at: s.sim_now })
        const sa = e.D.attempts_refresh.find((x) => x.vendor_id === alt.vendor)
        if (sa) s.vendor_attempts.push({ ...sa, at: s.sim_now })
        e.tl('schedule', `${alt.vendor} lead time +${alt.days} d`, 'error')
        e.audit('schedule', 'schedule.slip', `${e.vname(alt.vendor)} re-confirmed its lead time ${alt.days} d longer; CPM now misses the ${e.story.rosLabel}.`, { outputs: { vendor: alt.vendor, slip_days: alt.days }, task_id: 'R2-alternate', confidence: 0.9 })
      }
      e.finish('R2-alternate', ['R3-rebudget'])
    },
  },
  {
    node: 'budget',
    hours: 3,
    run: (e) => {
      const s = e.snap
      s.options = clone(e.D.options_replan)
      const rec = s.options.find((o) => o.recommended)!
      s.schedule = clone(e.D.schedules[rec.vendor_id] ?? null)
      e.finish('R3-rebudget', ['R4-memo'])
      const u = (o: VendorOption) => pct1(committedOf(o) / s.goal.budget_inr)
      e.tl('budget', `${rec.vendor_id} ${rec.budget_verdict} ${u(rec)}`, 'info')
      e.audit('budget', 'budget.checked', `Re-checked all options: ${s.options.map((o) => `${o.option_id} ${u(o)} (${o.budget_verdict})`).join(', ')}.`, { task_id: 'R3-rebudget', confidence: 0.95 })
      e.point(committedOf(rec))
    },
  },
  {
    node: 'approvals',
    hours: 3,
    run: (e) => {
      e.finish('R4-memo')
      e.requestVendorApproval(e.D.memo.situation, clone(e.D.memo))
    },
  },
  {
    node: 'approvals',
    hours: 0,
    gate: 'vendor_selection',
    run: (e) => {
      const s = e.snap
      const appr = [...s.approvals].reverse().find((a) => a.kind === 'vendor_selection' && a.status === 'approved')!
      const opt = s.options.find((o) => o.option_id === appr.decided_option) ?? s.options[0]!
      s.schedule = clone(e.D.schedules[opt.vendor_id] ?? null)
      const draft = s.plan?.tasks.find((x) => x.title === 'Draft PO' && x.status === 'pending')
      if (draft) e.task(draft.id, 'running')
    },
  },
  {
    node: 'po',
    hours: 20,
    run: (e) => {
      const s = e.snap
      const appr = [...s.approvals].reverse().find((a) => a.kind === 'vendor_selection' && a.status === 'approved')!
      const opt = s.options.find((o) => o.option_id === appr.decided_option) ?? s.options[0]!
      const po = draftPO(e, opt)
      s.po = po
      const id = `${s.run_id}:po-release:${po.po_number}`
      e.ledger(`${s.run_id}:approve-po:approval.requested:${po.po_number}`, 'approval.requested', { approval_id: id }, { status: 'pending' })
      s.approvals.push({
        id,
        run_id: s.run_id,
        kind: 'po_release',
        title: `Release ${po.po_number} to ${po.vendor_name}`,
        summary: `PO for ${cr(po.total_inr)} incl. 18 % GST (${cr(po.subtotal_inr + po.freight_inr + po.expedite_fee_inr)} ex-GST), contractual delivery ${po.delivery_date}.`,
        memo: null,
        po,
        options: [],
        status: 'pending',
        decided_option: null,
        decided_by: null,
        comment: null,
        requested_at: s.sim_now,
        decided_at: null,
      })
      const draft = s.plan?.tasks.find((x) => x.title === 'Draft PO' && x.status === 'running')
      if (draft) e.finish(draft.id)
      const ap = s.plan?.tasks.find((x) => x.title === 'Approve PO release' && x.status === 'pending')
      if (ap) e.task(ap.id, 'waiting_human')
      e.tl('po', `Draft ${po.po_number}`, 'info')
      e.tl('approvals', 'PO release → PM', 'human')
      e.audit('po', 'po.drafted', `Drafted ${po.po_number}: ${po.lines.length} lines, ${cr(po.subtotal_inr)} + freight ${lakh(po.freight_inr)}${po.expedite_fee_inr ? ` + expedite ${lakh(po.expedite_fee_inr)}` : ''} + 18 % GST = ${cr(po.total_inr)}.`, { outputs: { po_number: po.po_number, total_inr: po.total_inr }, task_id: draft?.id ?? 'po', llm_tokens: 980, confidence: 0.96 })
    },
  },
  {
    node: 'po',
    hours: 0.5,
    gate: 'po_release',
    run: (e) => {
      const s = e.snap
      const po = s.po!
      po.status = 'sent'
      po.issued_at = s.sim_now
      po.markdown = po.markdown.replace(/\*\*Status:\*\* DRAFT/, '**Status:** SENT')
      const send = s.plan?.tasks.find((x) => x.title === 'Send PO' && x.status === 'pending')
      e.ledger(`${s.run_id}:${send?.id ?? 'send'}:po.sent:${po.po_number}`, 'po.sent', { po_number: po.po_number, vendor: po.vendor_id }, { message_id: 'po-7781', accepted: true })
      if (send) {
        e.task(send.id, 'running')
        e.finish(send.id)
      }
      e.tl('po', `${po.po_number} SENT`, 'success')
      const committed = po.subtotal_inr + po.freight_inr + po.expedite_fee_inr
      e.audit('po', 'po.sent', `${po.po_number} dispatched to ${po.vendor_name}; ${cr(committed)} committed ex-GST. Idempotent: ledger key po.sent executes once.`, { outputs: { po_number: po.po_number, accepted: true }, cost_inr: committed, task_id: send?.id ?? 'po', confidence: 1 })
      const rec = s.options.find((o) => o.vendor_id === po.vendor_id && o.expedite_fee_inr === po.expedite_fee_inr)
      e.point(rec ? committedOf(rec) : committed, committed)
    },
  },
]

export const TOTAL_STEPS = STEPS.length
