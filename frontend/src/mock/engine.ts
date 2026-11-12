// In-browser simulation of the SiteMind durable worker. Produces RunSnapshots that follow the
// exact shapes of backend/sitemind/models.py so the UI can be built and demoed without a backend.
import type {
  ApprovalDecision,
  BudgetCheck,
  TakeoffResult,
  VendorAttempt,
  ApprovalRequest,
  AuditEntry,
  CreateRunRequest,
  DecisionMemo,
  JsonDict,
  Plan,
  PlanTask,
  PurchaseOrder,
  Quote,
  RunSnapshot,
  ScheduleResult,
  TaskStatus,
  TimelineKind,
  VendorOption,
} from '../types'
import { CONTINGENCY, REQUIRED_ON_SITE, SIM_START } from './scenario'
import data from './specialists.json'

const IST = 5.5 * 3600_000

export function isoIST(ms: number): string {
  return new Date(ms + IST).toISOString().replace(/\.\d{3}Z$/, '+05:30')
}
const round = (n: number) => Math.round(n)

// --------------------------------------------------------------------------- data
// Specialist outputs generated from the real backend specialists (scripts/gen_mock_data.py).

const D = data as unknown as {
  takeoff: TakeoffResult
  quotes_r1: Quote[]
  attempts_r1: VendorAttempt[]
  options_initial: VendorOption[]
  quotes_refreshed: Quote[]
  attempts_refresh: VendorAttempt[]
  options_replan: VendorOption[]
  budgets_initial: BudgetCheck[]
  budgets_replan: BudgetCheck[]
  schedules: Record<string, ScheduleResult>
  expedite: Record<string, { vendor_id: string; days_saved: number; fee_inr: number; description: string }>
  memo: DecisionMemo
  pos: Record<string, PurchaseOrder>
}

const q1 = (v: string) => D.quotes_r1.find((q) => q.vendor_id === v)!
const committedOf = (o: VendorOption) => o.total_inr + (o.total_inr - o.expedite_fee_inr) * CONTINGENCY
const cr = (n: number) => `₹${(n / 1e7).toFixed(2)} Cr`
const lakh = (n: number) => `₹${(n / 1e5).toFixed(1)} L`

// --------------------------------------------------------------------------- engine

interface Step {
  node: string
  /** hours of sim time this step consumes before executing */
  hours: number
  run: (e: MockEngine) => void
  /** if set, the step blocks until the approval with this kind is decided */
  gate?: ApprovalRequest['kind']
}

let pidSeq = 48211

export class MockEngine {
  snap: RunSnapshot
  private cursor = 0
  private now: number
  private seq = 0
  private quotesBy: Record<string, Quote> = {}
  private lastLedgerKey: string | null = null

  constructor(runId: string, req: CreateRunRequest) {
    this.now = Date.parse(SIM_START)
    this.snap = {
      run_id: runId,
      goal: {
        text: req.goal_text,
        project: req.project ?? 'Project Alpha',
        package: req.package ?? '480 V switchgear',
        need_by: req.need_by,
        required_on_site: REQUIRED_ON_SITE,
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
    }
  }

  get done(): boolean {
    return this.cursor >= STEPS.length
  }

  /** Advance one super-step. Returns false when blocked / finished / killed. */
  tick(): boolean {
    const s = this.snap
    if (s.status === 'killed' || s.status === 'completed' || s.status === 'failed') return false
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
    // The interrupted super-step re-requests its last side effect: the ledger dedups it.
    if (this.lastLedgerKey) {
      const entry = s.ledger.find((l) => l.idempotency_key === this.lastLedgerKey)
      if (entry) entry.executions += 1
    }
    // Make the gate re-evaluate.
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
    const task = this.snap.plan?.tasks.find((t) => t.status === 'waiting_human')
    if (task) this.task(task.id, a.status === 'approved' ? 'done' : 'failed')
    if (a.status === 'rejected') {
      s.status = 'failed'
      s.error = 'Rejected by approver; agent halted pending new instructions.'
      return
    }
    s.status = 'running'
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
      this.ledger(`${s.run_id}:${extra.task_id ?? 'run'}:llm.call:${action}`, 'llm.call', { action }, { tokens: extra.llm_tokens })
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
    const t = this.snap.plan?.tasks.find((x) => x.id === id)
    if (!t) return
    if (status === 'running' || status === 'waiting_human') t.started_at ??= isoIST(this.now)
    if (status === 'done' || status === 'failed') {
      t.started_at ??= isoIST(this.now)
      t.finished_at = isoIST(this.now)
    }
    if (status === 'running') t.attempts++
    t.status = status
    if (note) t.note = note
  }

  /** mark `id` done and start the next tasks */
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

  // ---------------------------------------------------------------- scenario state
  get quotes() {
    return this.quotesBy
  }
  setQuote(q: Quote) {
    this.quotesBy[q.vendor_id] = q
    const s = this.snap
    s.quotes = ['V1', 'V2', 'V3'].map((v) => this.quotesBy[v]).filter((x): x is Quote => !!x)
  }
  get simNow() {
    return this.now
  }
}

// --------------------------------------------------------------------------- plan definitions

function t(id: string, title: string, specialist: string, deps: string[], v: number, extra: Partial<PlanTask> = {}): PlanTask {
  return { id, title, specialist, depends_on: deps, deadline: null, budget_inr: 0, status: 'pending', attempts: 0, plan_version: v, started_at: null, finished_at: null, output_ref: null, note: null, ...extra }
}

function planV1(now: string): Plan {
  return {
    version: 1,
    created_at: now,
    rationale:
      'Decompose the ordering goal into takeoff → parallel RFQs → schedule & budget checks → evaluation → two human gates (vendor selection, PO release) → idempotent PO dispatch. Work back from the 30 Jul energisation window: PO must issue by 15 Mar.',
    risks: [
      { id: 'R1', title: 'Vendor non-response delays quote comparison', likelihood: 'medium', impact: 'medium', mitigation: 'Retry with exponential backoff, up to 3 attempts per vendor.' },
      { id: 'R2', title: 'Copper price volatility revises quotes', likelihood: 'medium', impact: 'high', mitigation: 'Refresh quotes before memo; keep 5 % contingency.' },
      { id: 'R3', title: 'Long lead time misses energisation window', likelihood: 'medium', impact: 'high', mitigation: 'CPM float check per vendor; evaluate expedite offers.' },
    ],
    tasks: [
      t('T1-takeoff', 'Spec takeoff', 'takeoff', [], 1, { deadline: '2027-01-13' }),
      t('T2-rfq', 'RFQ to 3 vendors', 'quotes', ['T1-takeoff'], 1, { deadline: '2027-01-20' }),
      t('T3-schedule', 'CPM schedule check', 'schedule', ['T2-rfq'], 1),
      t('T4-budget', 'Budget check', 'budget', ['T2-rfq'], 1),
      t('T5-evaluate', 'Refresh & rank quotes', 'approvals', ['T3-schedule', 'T4-budget'], 1),
      t('T6-approve-vendor', 'Approve vendor', 'approvals', ['T5-evaluate'], 1),
      t('T7-draft-po', 'Draft PO', 'po', ['T6-approve-vendor'], 1),
      t('T8-approve-po', 'Approve PO release', 'approvals', ['T7-draft-po'], 1),
      t('T9-send-po', 'Send PO', 'po', ['T8-approve-po'], 1, { deadline: '2027-03-15' }),
    ],
  }
}

function planV2(prev: Plan, now: string): Plan {
  const keep = prev.tasks.map((x) => {
    const c = { ...x }
    if (['T6-approve-vendor', 'T7-draft-po', 'T8-approve-po', 'T9-send-po'].includes(c.id)) {
      c.status = 'skipped'
      c.note = 'Superseded by plan v2 (price revision)'
    }
    return c
  })
  return {
    version: 2,
    created_at: now,
    rationale:
      'Kestrel (V2) revised +14.3 % on refresh (copper surcharge, discount withdrawn), pushing committed cost to 100.8 % of budget. Re-plan: attempt re-negotiation with V2, price the Anvil (V3) 42-day expedite, re-run budget across all options, then put a decision memo to the PM.',
    risks: [
      ...prev.risks,
      { id: 'R4', title: 'Expedite option sits above the 90 % budget warning line', likelihood: 'medium', impact: 'medium', mitigation: 'Tie expedite fee to delivery milestone; LDs 0.5 %/week capped at 10 %.' },
    ],
    tasks: [
      ...keep,
      t('R1-renegotiate', 'Re-negotiate V2 price', 'quotes', ['T5-evaluate'], 2),
      t('R2-expedite', 'Price V3 expedite', 'schedule', ['T5-evaluate'], 2),
      t('R3-rebudget', 'Re-check budget', 'budget', ['R1-renegotiate', 'R2-expedite'], 2),
      t('R4-memo', 'Decision memo', 'approvals', ['R3-rebudget'], 2),
      t('R5-approve-vendor', 'Approve vendor', 'approvals', ['R4-memo'], 2),
      t('R6-draft-po', 'Draft PO', 'po', ['R5-approve-vendor'], 2),
      t('R7-approve-po', 'Approve PO release', 'approvals', ['R6-draft-po'], 2),
      t('R8-send-po', 'Send PO', 'po', ['R7-approve-po'], 2, { deadline: '2027-03-15' }),
    ],
  }
}

function withTime<T extends { received_at?: string | null }>(q: T, at: string): T {
  return { ...structuredClone(q), received_at: at }
}

const optById = (list: VendorOption[], id: string) => list.find((o) => o.option_id === id)!

// --------------------------------------------------------------------------- the script

const STEPS: Step[] = [
  {
    node: 'planner',
    hours: 0.5,
    run: (e) => {
      const s = e.snap
      s.plan = planV1(s.sim_now)
      s.plan_history = [structuredClone(s.plan)]
      e.task('T1-takeoff', 'running')
      e.tl('planner', 'Plan v1 · 9 tasks', 'info')
      e.audit('planner', 'plan.created', 'Built a 9-task DAG working back from the 30 Jul energisation window; PO must be issued by 15 Mar within the ₹4.60 Cr ceiling.', {
        inputs: { goal: s.goal.text },
        outputs: { tasks: 9, risks: 3 },
        llm_tokens: 1240,
        confidence: 0.86,
        task_id: 'plan',
      })
      e.point(42_000_000)
    },
  },
  {
    node: 'takeoff',
    hours: 2,
    run: (e) => {
      const s = e.snap
      s.takeoff = structuredClone(D.takeoff)
      e.finish('T1-takeoff', ['T2-rfq'])
      e.tl('takeoff', `${D.takeoff.lines.length} lines · ${Math.round(D.takeoff.confidence * 100)} %`, 'success')
      e.tl('takeoff', 'SPD qty mismatch → RFI', 'warning')
      e.audit('takeoff', 'takeoff.completed', `Extracted ${D.takeoff.lines.length} BOQ lines from the equipment schedule and cross-checked the single-line diagram. ${D.takeoff.warnings[0] ?? ''}`, {
        inputs: { pdf: D.takeoff.document },
        outputs: { lines: D.takeoff.lines.length, confidence: D.takeoff.confidence, warnings: D.takeoff.warnings },
        confidence: D.takeoff.confidence,
        task_id: 'T1-takeoff',
      })
    },
  },
  {
    node: 'quotes',
    hours: 0.5,
    run: (e) => {
      const s = e.snap
      for (const v of ['V1', 'V2', 'V3']) e.ledger(`${s.run_id}:T2-rfq:rfq.sent:${v}:1`, 'rfq.sent', { vendor: v, lines: D.takeoff.lines.length, attempt: 1 }, { message_id: `rfq-${v.toLowerCase()}-0111` })
      e.tl('quotes', 'RFQ → V1 · V2 · V3', 'info')
      e.audit('quotes', 'rfq.sent', `Issued RFQ for ${D.takeoff.lines.length} lines to Voltaris, Kestrel and Anvil; 24 h response window, max 3 attempts.`, { inputs: { vendors: ['V1', 'V2', 'V3'] }, task_id: 'T2-rfq' })
    },
  },
  {
    node: 'quotes',
    hours: 24,
    run: (e) => {
      const s = e.snap
      e.setQuote(withTime(q1('V2'), s.sim_now))
      s.vendor_attempts.push(
        { vendor_id: 'V2', attempt: 1, outcome: 'ok', at: s.sim_now, detail: `${q1('V2').quote_id} received` },
        { vendor_id: 'V1', attempt: 1, outcome: 'timeout', at: s.sim_now, detail: 'No response within 24 h' },
      )
      e.tl('quotes', 'V2 quoted', 'success')
      e.tl('quotes', 'V1 timeout #1', 'warning')
      e.audit('quotes', 'quote.timeout', 'Voltaris (V1) did not answer within the 24 h window; retry 2/3 scheduled.', { inputs: { vendor: 'V1', attempt: 1 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
      e.ledger(`${s.run_id}:T2-rfq:rfq.sent:V1:2`, 'rfq.sent', { vendor: 'V1', attempt: 2 }, { message_id: 'rfq-v1-0112' })
    },
  },
  {
    node: 'quotes',
    hours: 24,
    run: (e) => {
      const s = e.snap
      e.setQuote(withTime(q1('V3'), s.sim_now))
      s.vendor_attempts.push(
        { vendor_id: 'V3', attempt: 1, outcome: 'ok', at: s.sim_now, detail: `${q1('V3').quote_id} received` },
        { vendor_id: 'V1', attempt: 2, outcome: 'timeout', at: s.sim_now, detail: 'No response within 24 h' },
      )
      e.tl('quotes', 'V3 quoted', 'success')
      e.tl('quotes', 'V1 timeout #2', 'warning')
      e.audit('quotes', 'quote.timeout', 'Voltaris (V1) timed out again; escalating to regional sales contact for attempt 3/3.', { inputs: { vendor: 'V1', attempt: 2 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
      e.ledger(`${s.run_id}:T2-rfq:rfq.sent:V1:3`, 'rfq.sent', { vendor: 'V1', attempt: 3 }, { message_id: 'rfq-v1-0113' })
    },
  },
  {
    node: 'quotes',
    hours: 30,
    run: (e) => {
      const s = e.snap
      e.setQuote(withTime(q1('V1'), s.sim_now))
      s.vendor_attempts.push({ vendor_id: 'V1', attempt: 3, outcome: 'ok', at: s.sim_now, detail: `${q1('V1').quote_id} received` })
      e.finish('T2-rfq', ['T3-schedule', 'T4-budget'])
      e.tl('quotes', 'V1 quoted (attempt 3)', 'success')
      e.audit('quotes', 'quote.received', `All 3 quotes in (ex-GST). Voltaris ${cr(q1('V1').total_inr)}, Kestrel ${cr(q1('V2').total_inr)}, Anvil ${cr(q1('V3').total_inr)}.`, {
        outputs: { V1: q1('V1').total_inr, V2: q1('V2').total_inr, V3: q1('V3').total_inr },
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
      s.options = structuredClone(D.options_initial).map((o) => ({ ...o, recommended: false }))
      s.schedule = structuredClone(D.schedules.V2 ?? null)
      e.finish('T3-schedule')
      const f = (id: string) => optById(D.options_initial, id).float_days
      e.tl('schedule', `V3 late by ${-f('O-V3')} d`, 'error')
      e.audit('schedule', 'schedule.cpm', `CPM per vendor (PO 20 Jan → ROS 30 Jul): Kestrel +${f('O-V2')} d float, Voltaris +${f('O-V1')} d, Anvil ${f('O-V3')} d (misses energisation); Anvil expedite would give +${f('O-V3X')} d.`, {
        outputs: { 'O-V1': f('O-V1'), 'O-V2': f('O-V2'), 'O-V3': f('O-V3'), 'O-V3X': f('O-V3X') },
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
      s.options = structuredClone(D.options_initial)
      e.finish('T4-budget', ['T5-evaluate'])
      const rec = D.options_initial.find((o) => o.recommended)!
      e.tl('budget', `${rec.vendor_id} best · ${Math.round((committedOf(rec) / s.goal.budget_inr) * 100)} %`, 'success')
      e.audit('budget', 'budget.checked', `Kestrel leads (score ${rec.score.toFixed(3)}): committed ${cr(committedOf(rec))} incl. 5 % contingency = ${((committedOf(rec) / s.goal.budget_inr) * 100).toFixed(1)} % of budget.`, {
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
      const rev = D.quotes_refreshed.find((q) => q.vendor_id === 'V2')!
      e.setQuote(withTime(rev, s.sim_now))
      const ra = D.attempts_refresh.find((a) => a.vendor_id === 'V2')!
      s.vendor_attempts.push({ ...ra, at: s.sim_now })
      const o2 = optById(D.options_replan, 'O-V2')
      s.options = s.options.map((o) => (o.option_id === 'O-V2' ? { ...structuredClone(o2), recommended: false } : o))
      e.ledger(`${s.run_id}:T5-evaluate:quote.refresh:V2`, 'quote.refresh', { vendor: 'V2' }, { quote_id: rev.quote_id, revision: 2 })
      e.finish('T5-evaluate', [], 'V2 revised +14.3 % → budget breach')
      e.tl('quotes', 'V2 revised +14.3 %', 'error')
      e.tl('budget', `Forecast ${((committedOf(o2) / s.goal.budget_inr) * 100).toFixed(1)} % — breach`, 'error')
      e.audit('budget', 'budget.breach', `Quote refresh before award: Kestrel R2 ${cr(q1('V2').total_inr)} → ${cr(rev.total_inr)} (+11 % copper surcharge, 3 % discount withdrawn). Committed ${cr(committedOf(o2))} exceeds the ₹4.60 Cr ceiling by ${lakh(committedOf(o2) - s.goal.budget_inr)}.`, {
        inputs: { vendor: 'V2', revision: 2 },
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
      s.plan = planV2(s.plan!, s.sim_now)
      s.plan_history.push(structuredClone(s.plan))
      e.task('R1-renegotiate', 'running')
      e.task('R2-expedite', 'running')
      e.tl('planner', 'Re-plan v2 · price revision', 'warning')
      e.audit('planner', 'replan', 'Re-planned (v2): +8 tasks, 4 superseded. Trigger: Kestrel price revision breached budget. Try re-negotiation, price the Anvil expedite, then put a decision memo to the PM.', {
        inputs: { trigger: 'price_revision', vendor: 'V2' },
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
      e.ledger(`${s.run_id}:R1-renegotiate:negotiation.sent:V2`, 'negotiation.sent', { vendor: 'V2', target_inr: q1('V2').total_inr }, { reply: 'declined' })
      s.vendor_attempts.push({ vendor_id: 'V2', attempt: 3, outcome: 'declined', at: s.sim_now, detail: 'Will not hold R1 price — surcharge is LME-indexed' })
      e.finish('R1-renegotiate')
      e.tl('quotes', 'V2 declines to hold price', 'warning')
      e.audit('quotes', 'negotiation.declined', 'Kestrel declined to hold the R1 price; the copper surcharge is passed through under its price-variation clause.', { inputs: { vendor: 'V2' }, outputs: { reply: 'declined' }, task_id: 'R1-renegotiate', llm_tokens: 640, confidence: 0.88 })
    },
  },
  {
    node: 'schedule',
    hours: 3,
    run: (e) => {
      const s = e.snap
      const x = D.expedite.V3!
      const ox = optById(D.options_replan, 'O-V3X')
      e.ledger(`${s.run_id}:R2-expedite:expedite.requested:V3`, 'expedite.requested', { vendor: 'V3', days: x.days_saved }, { fee_inr: x.fee_inr })
      e.finish('R2-expedite', ['R3-rebudget'])
      e.tl('schedule', `V3 expedite −${x.days_saved} d`, 'success')
      e.audit('schedule', 'expedite.priced', `Anvil confirms −${x.days_saved} d expedite for ${lakh(x.fee_inr)}: delivery ${ox.delivery_date}, float moves from ${optById(D.options_replan, 'O-V3').float_days} d to +${ox.float_days} d.`, { outputs: { fee_inr: x.fee_inr, float_days: ox.float_days }, task_id: 'R2-expedite', confidence: 0.9 })
    },
  },
  {
    node: 'budget',
    hours: 3,
    run: (e) => {
      const s = e.snap
      s.options = structuredClone(D.options_replan)
      const rec = D.options_replan.find((o) => o.recommended)!
      s.schedule = structuredClone(D.schedules[rec.vendor_id] ?? null)
      e.finish('R3-rebudget', ['R4-memo'])
      const u = (id: string) => Math.round((committedOf(optById(D.options_replan, id)) / s.goal.budget_inr) * 1000) / 10
      e.tl('budget', `V3X warn ${u('O-V3X')} % · V1 ok ${u('O-V1')} %`, 'info')
      e.audit('budget', 'budget.checked', `Re-checked all options: Anvil+expedite ${u('O-V3X')} % (warn), Voltaris ${u('O-V1')} % (ok), Kestrel R2 ${u('O-V2')} % (breach), Anvil standard late.`, { task_id: 'R3-rebudget', confidence: 0.95 })
      e.point(committedOf(rec))
    },
  },
  {
    node: 'approvals',
    hours: 3,
    run: (e) => {
      const s = e.snap
      const memo = structuredClone(D.memo)
      const id = `${s.run_id}:vendor-selection:v2`
      e.ledger(`${s.run_id}:R5-approve-vendor:approval.requested:v2`, 'approval.requested', { approval_id: id }, { status: 'pending' })
      const feasible = memo.options.filter((o) => o.budget_verdict !== 'breach' && o.meets_deadline).map((o) => o.option_id)
      const rec = memo.options.find((o) => o.option_id === memo.recommendation)!
      s.approvals.push({
        id,
        run_id: s.run_id,
        kind: 'vendor_selection',
        title: 'Select switchgear vendor',
        summary: `Kestrel breached budget after its R2 revision. Recommend ${rec.vendor_name} with expedite (${cr(rec.total_inr)} ex-GST, +${rec.float_days} d float).`,
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
      e.finish('R4-memo')
      e.task('R5-approve-vendor', 'waiting_human')
      e.tl('approvals', 'Decision memo → PM', 'human')
      e.audit('approvals', 'approval.requested', `Decision memo ${memo.memo_id} sent to the project manager; recommending ${memo.recommendation}.`, { outputs: { recommendation: memo.recommendation, options: feasible }, task_id: 'R4-memo', llm_tokens: 2310, confidence: 0.83 })
    },
  },
  {
    node: 'approvals',
    hours: 0,
    gate: 'vendor_selection',
    run: (e) => {
      const s = e.snap
      const appr = s.approvals.find((a) => a.kind === 'vendor_selection')!
      const opt = s.options.find((o) => o.option_id === appr.decided_option) ?? s.options[0]!
      s.schedule = structuredClone(D.schedules[opt.vendor_id] ?? null)
      e.task('R6-draft-po', 'running')
    },
  },
  {
    node: 'po',
    hours: 20,
    run: (e) => {
      const s = e.snap
      const appr = s.approvals.find((a) => a.kind === 'vendor_selection')!
      const po = structuredClone(D.pos[appr.decided_option ?? ''] ?? D.pos['O-V3X']!)
      s.po = po
      const id = `${s.run_id}:po-release:${po.po_number}`
      e.ledger(`${s.run_id}:R7-approve-po:approval.requested:${po.po_number}`, 'approval.requested', { approval_id: id }, { status: 'pending' })
      s.approvals.push({
        id,
        run_id: s.run_id,
        kind: 'po_release',
        title: `Release ${po.po_number} to ${po.vendor_name}`,
        summary: `PO for ${cr(po.total_inr)} incl. 18 % GST (${cr(po.subtotal_inr + po.freight_inr + po.expedite_fee_inr)} ex-GST), contractual delivery ${po.delivery_date}. Requires PM sign-off before dispatch.`,
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
      e.finish('R6-draft-po')
      e.task('R7-approve-po', 'waiting_human')
      e.tl('po', `Draft ${po.po_number}`, 'info')
      e.tl('approvals', 'PO release → PM', 'human')
      e.audit('po', 'po.drafted', `Drafted ${po.po_number}: ${po.lines.length} lines, ${cr(po.subtotal_inr)} + freight ${lakh(po.freight_inr)} + expedite ${lakh(po.expedite_fee_inr)} + 18 % GST = ${cr(po.total_inr)}.`, { outputs: { po_number: po.po_number, total_inr: po.total_inr }, task_id: 'R6-draft-po', llm_tokens: 980, confidence: 0.96 })
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
      e.ledger(`${s.run_id}:R8-send-po:po.sent:${po.po_number}`, 'po.sent', { po_number: po.po_number, vendor: po.vendor_id }, { message_id: 'po-0121-7781', accepted: true })
      e.task('R8-send-po', 'running')
      e.finish('R8-send-po')
      e.tl('po', `${po.po_number} SENT`, 'success')
      const committed = po.subtotal_inr + po.freight_inr + po.expedite_fee_inr
      e.audit('po', 'po.sent', `${po.po_number} dispatched to ${po.vendor_name}; ${cr(committed)} committed ex-GST. Idempotent: ledger key po.sent executes once.`, { outputs: { po_number: po.po_number, accepted: true }, cost_inr: committed, task_id: 'R8-send-po', confidence: 1 })
      const rec = s.options.find((o) => o.vendor_id === po.vendor_id && o.expedite_fee_inr === po.expedite_fee_inr)
      e.point(rec ? committedOf(rec) : committed, committed)
    },
  },
]

export const TOTAL_STEPS = STEPS.length
