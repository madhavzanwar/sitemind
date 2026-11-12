// In-browser simulation of the SiteMind durable worker. Produces RunSnapshots that follow the
// exact shapes of backend/sitemind/models.py so the UI can be built and demoed without a backend.
import type {
  ApprovalDecision,
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
  Verdict,
} from '../types'
import {
  BASE_UNIT_PRICE,
  CONTINGENCY,
  NON_MFG_DAYS,
  PROJECTED_PO_ISSUE,
  REQUIRED_ON_SITE,
  SIM_START,
  TAKEOFF_LINES,
  V2_REVISION,
  V3_EXPEDITE_DAYS,
  V3_EXPEDITE_FEE,
  VENDORS,
  type VendorProfile,
} from './scenario'

const IST = 5.5 * 3600_000
const DAY = 86_400_000

export function isoIST(ms: number): string {
  return new Date(ms + IST).toISOString().replace(/\.\d{3}Z$/, '+05:30')
}
function dateOnly(ms: number): string {
  return new Date(ms + IST).toISOString().slice(0, 10)
}
function addDays(d: string, n: number): string {
  return dateOnly(Date.parse(`${d}T12:00:00+05:30`) + n * DAY)
}
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / DAY)
}
const round = (n: number) => Math.round(n)

// --------------------------------------------------------------------------- builders

function buildQuote(v: VendorProfile, now: number, revision = 1, extraMult = 1): Quote {
  const lines = TAKEOFF_LINES.map((l) => {
    const unit = round((BASE_UNIT_PRICE[l.item_code] ?? 0) * v.mult * extraMult)
    return { item_code: l.item_code, qty: l.qty, unit_price_inr: unit, total_inr: unit * l.qty }
  })
  const total = lines.reduce((s, l) => s + l.total_inr, 0) + v.freight
  return {
    vendor_id: v.id,
    vendor_name: v.name,
    quote_id: `Q-${v.id}-2027-${revision === 1 ? '001' : '00' + revision}`,
    revision,
    lines,
    freight_inr: v.freight,
    total_inr: total,
    lead_time_days: v.lead,
    valid_until: addDays(dateOnly(now), 30),
    reliability: v.reliability,
    status: revision > 1 ? 'revised' : 'received',
    received_at: isoIST(now),
    notes:
      revision > 1
        ? `Price revised +${Math.round(V2_REVISION * 100)} % — LME copper surcharge applied to busbars and busduct.`
        : `${v.city} works; ex-works + freight to Chakan MIDC.`,
  }
}

function buildSchedule(vendorId: string, lead: number, poIssue = PROJECTED_PO_ISSUE): ScheduleResult {
  const acts = [
    { id: 'A1', name: 'PO issue', duration_days: 0, depends_on: [] as string[] },
    { id: 'A2', name: 'Submittals / shop drawings', duration_days: 14, depends_on: ['A1'] },
    { id: 'A3', name: 'Drawing approval', duration_days: 7, depends_on: ['A2'] },
    { id: 'A4', name: 'Manufacture', duration_days: lead, depends_on: ['A3'] },
    { id: 'A5', name: 'Factory acceptance test', duration_days: 7, depends_on: ['A4'] },
    { id: 'A6', name: 'Shipping to site', duration_days: 6, depends_on: ['A5'] },
  ]
  const total = lead + NON_MFG_DAYS
  const window = diffDays(REQUIRED_ON_SITE, poIssue)
  const float = window - total
  let es = 0
  const activities = acts.map((a) => {
    const ef = es + a.duration_days
    const r = { ...a, early_start: es, early_finish: ef, late_start: es + float, late_finish: ef + float, slack_days: float, critical: true }
    es = ef
    return r
  })
  return {
    vendor_id: vendorId,
    activities,
    critical_path: activities.map((a) => a.id),
    po_issue_date: poIssue,
    delivery_date: addDays(poIssue, total),
    required_on_site: REQUIRED_ON_SITE,
    float_days: float,
    meets_deadline: float >= 0,
  }
}

function verdictFor(committed: number, budget: number): Verdict {
  const u = committed / budget
  return u > 1 ? 'breach' : u > 0.95 ? 'warn' : 'ok'
}

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
  private expedite = false
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

  option(id: string, v: VendorProfile, q: Quote, expedite: boolean): VendorOption {
    const fee = expedite ? V3_EXPEDITE_FEE : 0
    const sch = buildSchedule(v.id, v.lead - (expedite ? V3_EXPEDITE_DAYS : 0))
    const committed = (q.total_inr + fee) * (1 + CONTINGENCY)
    const verdict = verdictFor(committed, this.snap.goal.budget_inr)
    return {
      option_id: id,
      vendor_id: v.id,
      vendor_name: v.name,
      total_inr: q.total_inr + fee,
      lead_time_days: v.lead - (expedite ? V3_EXPEDITE_DAYS : 0),
      delivery_date: sch.delivery_date,
      float_days: sch.float_days,
      reliability: v.reliability,
      expedite_fee_inr: fee,
      budget_verdict: verdict,
      meets_deadline: sch.meets_deadline,
      score: 0,
      recommended: false,
      rationale: '',
    }
  }

  // ---------------------------------------------------------------- scenario state
  get quotes() {
    return this.quotesBy
  }
  setQuote(q: Quote) {
    this.quotesBy[q.vendor_id] = q
    const s = this.snap
    s.quotes = VENDORS.map((v) => this.quotesBy[v.id]).filter((x): x is Quote => !!x)
  }
  set expediteOn(v: boolean) {
    this.expedite = v
  }
  get expediteOn() {
    return this.expedite
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
      'Kestrel (V2) revised +11 % on refresh, pushing forecast to 105 % of budget. Re-plan: attempt re-negotiation with V2, price the Anvil (V3) 42-day expedite, re-run budget across all options, then put a decision memo to the PM.',
    risks: [
      ...prev.risks,
      { id: 'R4', title: 'Recommended vendor has lower on-time reliability', likelihood: 'medium', impact: 'medium', mitigation: 'LD clause 0.5 %/week, weekly expediting calls, FAT witness.' },
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

const V1 = VENDORS[0]!
const V2 = VENDORS[1]!
const V3 = VENDORS[2]!

function cr(n: number) {
  return `₹${(n / 1e7).toFixed(2)} Cr`
}

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
      e.audit('planner', 'plan.created', 'Built a 9-task DAG working back from the 30 Jul energisation window; PO must be issued by 15 Mar with ₹4.6 Cr ceiling.', {
        inputs: { goal: s.goal.text },
        outputs: { tasks: 9, risks: 3 },
        llm_tokens: 1240,
        confidence: 0.86,
        task_id: 'plan',
      })
      e.point(43_000_000)
    },
  },
  {
    node: 'takeoff',
    hours: 2.5,
    run: (e) => {
      const s = e.snap
      s.takeoff = { document: 'Alpha-E-SPEC-480V-SWGR-rev C.pdf', lines: TAKEOFF_LINES, confidence: 0.94, warnings: ['Busduct run length inferred from SLD (120 m) — confirm with site survey.'] }
      e.finish('T1-takeoff', ['T2-rfq'])
      e.tl('takeoff', '7 line items · 94 %', 'success')
      e.audit('takeoff', 'takeoff.completed', 'Extracted 7 BOQ lines from the switchgear spec (4 × 4000 A mains, 2 ties, 8 distribution sections, 48 feeders).', {
        inputs: { pdf: 'Alpha-E-SPEC-480V-SWGR-rev C.pdf' },
        outputs: { lines: 7, confidence: 0.94 },
        confidence: 0.94,
        task_id: 'T1-takeoff',
      })
    },
  },
  {
    node: 'quotes',
    hours: 2.5,
    run: (e) => {
      const s = e.snap
      for (const v of VENDORS) e.ledger(`${s.run_id}:T2-rfq:rfq.sent:${v.id}`, 'rfq.sent', { vendor: v.id, lines: 7 }, { message_id: `rfq-${v.id.toLowerCase()}-0111` })
      e.tl('quotes', 'RFQ → V1 · V2 · V3', 'info')
      e.audit('quotes', 'rfq.sent', 'Issued RFQ for 7 lines to Voltaris, Kestrel and Anvil; response window 48 h.', { inputs: { vendors: ['V1', 'V2', 'V3'] }, task_id: 'T2-rfq' })
    },
  },
  {
    node: 'quotes',
    hours: 44,
    run: (e) => {
      const s = e.snap
      e.setQuote(buildQuote(V2, e.simNow))
      e.setQuote(buildQuote(V3, e.simNow))
      s.vendor_attempts.push(
        { vendor_id: 'V2', attempt: 1, outcome: 'ok', at: s.sim_now, detail: 'Quote Q-V2-2027-001 received' },
        { vendor_id: 'V3', attempt: 1, outcome: 'ok', at: s.sim_now, detail: 'Quote Q-V3-2027-001 received' },
        { vendor_id: 'V1', attempt: 1, outcome: 'timeout', at: s.sim_now, detail: 'No response within 48 h' },
      )
      e.tl('quotes', 'V2, V3 quoted', 'success')
      e.tl('quotes', 'V1 timeout #1', 'warning')
      e.audit('quotes', 'quote.timeout', 'Voltaris (V1) did not answer within the 48 h window; scheduling retry 2/3 with backoff.', { inputs: { vendor: 'V1', attempt: 1 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
      e.point((e.quotes.V2?.total_inr ?? 0) * (1 + CONTINGENCY))
    },
  },
  {
    node: 'quotes',
    hours: 48,
    run: (e) => {
      const s = e.snap
      e.ledger(`${s.run_id}:T2-rfq:rfq.sent:V1:2`, 'rfq.sent', { vendor: 'V1', attempt: 2 }, { message_id: 'rfq-v1-0115' })
      s.vendor_attempts.push({ vendor_id: 'V1', attempt: 2, outcome: 'timeout', at: s.sim_now, detail: 'No response within 48 h' })
      e.tl('quotes', 'V1 timeout #2', 'warning')
      e.audit('quotes', 'quote.timeout', 'Voltaris (V1) timed out again; escalating to regional sales contact for attempt 3/3.', { inputs: { vendor: 'V1', attempt: 2 }, outputs: { outcome: 'timeout' }, task_id: 'T2-rfq' })
    },
  },
  {
    node: 'quotes',
    hours: 49,
    run: (e) => {
      const s = e.snap
      e.ledger(`${s.run_id}:T2-rfq:rfq.sent:V1:3`, 'rfq.sent', { vendor: 'V1', attempt: 3 }, { message_id: 'rfq-v1-0117' })
      e.setQuote(buildQuote(V1, e.simNow))
      s.vendor_attempts.push({ vendor_id: 'V1', attempt: 3, outcome: 'ok', at: s.sim_now, detail: 'Quote Q-V1-2027-001 received' })
      e.finish('T2-rfq', ['T3-schedule', 'T4-budget'])
      e.tl('quotes', 'V1 quoted (attempt 3)', 'success')
      e.audit('quotes', 'quote.received', `All 3 quotes in. Voltaris ${cr(e.quotes.V1!.total_inr)}, Kestrel ${cr(e.quotes.V2!.total_inr)}, Anvil ${cr(e.quotes.V3!.total_inr)}.`, {
        outputs: { V1: e.quotes.V1!.total_inr, V2: e.quotes.V2!.total_inr, V3: e.quotes.V3!.total_inr },
        task_id: 'T2-rfq',
        confidence: 0.97,
      })
    },
  },
  {
    node: 'schedule',
    hours: 4,
    run: (e) => {
      const s = e.snap
      s.options = [e.option('O1', V1, e.quotes.V1!, false), e.option('O2', V2, e.quotes.V2!, false), e.option('O3', V3, e.quotes.V3!, false)]
      s.schedule = buildSchedule('V2', V2.lead)
      e.finish('T3-schedule')
      e.tl('schedule', 'V3 misses by 20 d', 'error')
      e.audit('schedule', 'schedule.cpm', 'CPM forward/backward pass per vendor: Kestrel +36 d float, Voltaris +8 d, Anvil −20 d (misses 30 Jul energisation).', {
        outputs: { V1: 8, V2: 36, V3: -20 },
        task_id: 'T3-schedule',
        confidence: 0.92,
      })
    },
  },
  {
    node: 'budget',
    hours: 19,
    run: (e) => {
      const s = e.snap
      s.options = s.options.map((o, i) => ({ ...o, score: [0.71, 0.84, 0.52][i] ?? 0, recommended: o.vendor_id === 'V2' }))
      e.finish('T4-budget', ['T5-evaluate'])
      e.tl('budget', 'All within ₹4.6 Cr', 'success')
      e.audit('budget', 'budget.checked', `Kestrel leads on score (0.84): ${cr(e.quotes.V2!.total_inr * 1.05)} incl. 5 % contingency = 95 % utilisation.`, {
        outputs: { forecast: e.quotes.V2!.total_inr * 1.05 },
        task_id: 'T4-budget',
        confidence: 0.9,
      })
    },
  },
  {
    node: 'approvals',
    hours: 24,
    run: (e) => {
      const s = e.snap
      const rev = buildQuote(V2, e.simNow, 2, 1 + V2_REVISION)
      e.setQuote(rev)
      s.vendor_attempts.push({ vendor_id: 'V2', attempt: 2, outcome: 'revised', at: s.sim_now, detail: '+11 % copper surcharge' })
      s.options = s.options.map((o) => (o.vendor_id === 'V2' ? { ...e.option('O2', V2, rev, false), score: 0.58 } : o))
      e.finish('T5-evaluate', [], 'V2 revised +11 % → breach')
      e.tl('quotes', 'V2 revised +11 %', 'error')
      e.tl('budget', 'Forecast 105 % — breach', 'error')
      e.audit('budget', 'budget.breach', `Quote refresh: Kestrel revised to ${cr(rev.total_inr)} (+11 %, copper surcharge). Forecast ${cr(rev.total_inr * 1.05)} exceeds ₹4.60 Cr ceiling.`, {
        inputs: { vendor: 'V2', revision: 2 },
        outputs: { forecast: rev.total_inr * 1.05, verdict: 'breach' },
        task_id: 'T5-evaluate',
        confidence: 0.99,
      })
      e.point(rev.total_inr * (1 + CONTINGENCY))
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
      e.audit('planner', 'replan', 'Re-planned (v2): +8 tasks, 4 superseded. Trigger: Kestrel price revision breached budget. Explore re-negotiation and Anvil expedite before asking the PM.', {
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
    hours: 27,
    run: (e) => {
      const s = e.snap
      e.ledger(`${s.run_id}:R1-renegotiate:negotiation.sent:V2`, 'negotiation.sent', { vendor: 'V2', target_inr: 43_000_000 }, { reply: 'declined' })
      s.vendor_attempts.push({ vendor_id: 'V2', attempt: 3, outcome: 'declined', at: s.sim_now, detail: 'Will not hold original price' })
      e.finish('R1-renegotiate')
      e.tl('quotes', 'V2 declines to hold price', 'warning')
      e.audit('quotes', 'negotiation.declined', 'Kestrel declined to hold the original price; surcharge is passed through from LME copper.', { inputs: { vendor: 'V2' }, outputs: { reply: 'declined' }, task_id: 'R1-renegotiate', llm_tokens: 640, confidence: 0.88 })
    },
  },
  {
    node: 'schedule',
    hours: 19,
    run: (e) => {
      const s = e.snap
      e.expediteOn = true
      e.ledger(`${s.run_id}:R2-expedite:expedite.requested:V3`, 'expedite.requested', { vendor: 'V3', days: 42 }, { fee_inr: V3_EXPEDITE_FEE })
      s.options = s.options.map((o) => (o.vendor_id === 'V3' ? e.option('O3', V3, e.quotes.V3!, true) : o))
      s.schedule = buildSchedule('V1', V1.lead)
      e.finish('R2-expedite', ['R3-rebudget'])
      e.tl('schedule', 'V3 expedite −42 d', 'success')
      e.audit('schedule', 'expedite.priced', 'Anvil offers −42 d expedite (second shift on breaker line) for ₹18.5 L; float moves from −20 d to +22 d.', { outputs: { fee_inr: V3_EXPEDITE_FEE, float_days: 22 }, task_id: 'R2-expedite', confidence: 0.9 })
    },
  },
  {
    node: 'budget',
    hours: 6,
    run: (e) => {
      const s = e.snap
      s.options = s.options.map((o) => ({ ...o, score: o.vendor_id === 'V1' ? 0.81 : o.vendor_id === 'V3' ? 0.74 : 0.49, recommended: o.vendor_id === 'V1' }))
      e.finish('R3-rebudget', ['R4-memo'])
      e.tl('budget', 'V1 ok 89 % · V3 warn 96 %', 'info')
      e.audit('budget', 'budget.checked', 'Re-checked all options: Voltaris 89 % (ok), Anvil+expedite 96 % (warn), Kestrel 105 % (breach).', { task_id: 'R3-rebudget', confidence: 0.95 })
      e.point(e.quotes.V1!.total_inr * (1 + CONTINGENCY))
    },
  },
  {
    node: 'approvals',
    hours: 18,
    run: (e) => {
      const s = e.snap
      const memo: DecisionMemo = {
        memo_id: 'MEMO-ALPHA-SWGR-002',
        title: 'Vendor selection — 480 V switchgear, Project Alpha',
        situation:
          'Kestrel (V2), the plan-v1 front-runner, revised its quote +11 % on refresh, breaching the ₹4.6 Cr ceiling. Re-negotiation was declined. Two compliant paths remain: Voltaris (V1, cheapest, +8 d float, 82 % on-time history) or Anvil (V3) with a paid 42-day expedite (+22 d float, 96 % of budget).',
        options: s.options,
        recommendation: 'O1',
        reasoning:
          'Voltaris meets both hard constraints with ₹51 L of headroom and the highest weighted score (0.81). Its weaker reliability is mitigated contractually (LD 0.5 %/week, capped 5 %) and operationally (weekly expediting, FAT witness). Anvil is a credible fallback but consumes 96 % of budget and leaves no contingency for site changes.',
        risks: [
          'Voltaris float is only +8 days; a two-week factory slip would breach the energisation window.',
          'Voltaris needed 3 RFQ attempts — responsiveness during submittals must be monitored.',
          'Copper volatility may affect Voltaris at PO acceptance if validity lapses (quote valid 30 days).',
        ],
        asks: 'Approve Voltaris (O1), or select Anvil with expedite (O3). Kestrel (O2) is shown for reference only — it breaches budget.',
      }
      const id = `${s.run_id}:vendor-selection:v2`
      e.ledger(`${s.run_id}:R5-approve-vendor:approval.requested:v2`, 'approval.requested', { approval_id: id }, { status: 'pending' })
      s.approvals.push({
        id,
        run_id: s.run_id,
        kind: 'vendor_selection',
        title: 'Select switchgear vendor',
        summary: 'Kestrel breached budget after +11 % revision. Recommend Voltaris (₹3.88 Cr, +8 d float).',
        memo,
        po: null,
        options: ['O1', 'O3'],
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
      e.audit('approvals', 'approval.requested', 'Decision memo drafted and sent to project manager; recommending Voltaris (O1).', { outputs: { recommendation: 'O1' }, task_id: 'R4-memo', llm_tokens: 2310, confidence: 0.83 })
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
      s.schedule = buildSchedule(opt.vendor_id, opt.lead_time_days)
      e.task('R6-draft-po', 'running')
    },
  },
  {
    node: 'po',
    hours: 22,
    run: (e) => {
      const s = e.snap
      const appr = s.approvals.find((a) => a.kind === 'vendor_selection')!
      const opt = s.options.find((o) => o.option_id === appr.decided_option) ?? s.options[0]!
      const q = e.quotes[opt.vendor_id]!
      const po = draftPO(s, opt, q, e.simNow)
      s.po = po
      const id = `${s.run_id}:po-release:${po.po_number}`
      e.ledger(`${s.run_id}:R7-approve-po:approval.requested:${po.po_number}`, 'approval.requested', { approval_id: id }, { status: 'pending' })
      s.approvals.push({
        id,
        run_id: s.run_id,
        kind: 'po_release',
        title: `Release ${po.po_number} to ${po.vendor_name}`,
        summary: `PO for ${cr(po.total_inr)} incl. GST, delivery ${po.delivery_date}. Requires PM sign-off before dispatch.`,
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
      e.audit('po', 'po.drafted', `Drafted ${po.po_number}: ${po.lines.length} lines, ${cr(po.subtotal_inr)} + freight + 18 % GST = ${cr(po.total_inr)}.`, { outputs: { po_number: po.po_number, total_inr: po.total_inr }, task_id: 'R6-draft-po', llm_tokens: 980, confidence: 0.96 })
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
      po.markdown = po.markdown.replace('**Status:** DRAFT', '**Status:** SENT')
      e.ledger(`${s.run_id}:R8-send-po:po.sent:${po.po_number}`, 'po.sent', { po_number: po.po_number, to: 'orders@voltaris.example' }, { message_id: 'po-0126-7781', accepted: true })
      e.task('R8-send-po', 'running')
      e.finish('R8-send-po')
      e.tl('po', `${po.po_number} SENT`, 'success')
      e.audit('po', 'po.sent', `${po.po_number} dispatched to ${po.vendor_name} — 47 days ahead of the 15 Mar need-by date.`, { outputs: { po_number: po.po_number, accepted: true }, cost_inr: po.subtotal_inr + po.freight_inr + po.expedite_fee_inr, task_id: 'R8-send-po', confidence: 1 })
      e.point(po.subtotal_inr + po.freight_inr + po.expedite_fee_inr, po.subtotal_inr + po.freight_inr + po.expedite_fee_inr)
    },
  },
]

function inrFull(n: number) {
  return '₹' + Math.round(n).toLocaleString('en-IN')
}

function draftPO(s: RunSnapshot, opt: VendorOption, q: Quote, now: number): PurchaseOrder {
  const lines = q.lines.map((l, i) => {
    const tl = TAKEOFF_LINES.find((x) => x.item_code === l.item_code)
    return { line_no: i + 1, item_code: l.item_code, description: `${tl?.description ?? ''} (${tl?.rating ?? ''})`, qty: l.qty, unit_price_inr: l.unit_price_inr, total_inr: l.total_inr }
  })
  const subtotal = lines.reduce((a, l) => a + l.total_inr, 0)
  const gst = round((subtotal + q.freight_inr + opt.expedite_fee_inr) * 0.18)
  const total = subtotal + q.freight_inr + opt.expedite_fee_inr + gst
  const poNumber = 'PO-ALPHA-2027-0042'
  const terms = [
    'Liquidated damages 0.5 % of PO value per week of delay, capped at 5 %.',
    'Factory acceptance test witnessed by Alpha EPC; 7 days notice.',
    'Type-tested to IEC 61439-1/2; arc-flash containment per IEC/TR 61641.',
    'Warranty 24 months from energisation or 30 months from delivery, whichever earlier.',
  ]
  const md = [
    `# Purchase Order ${poNumber}`,
    '',
    `**Project:** ${s.goal.project} — 24 MW Tier-III data centre, Chakan MIDC, Pune  `,
    `**Package:** ${s.goal.package}  `,
    `**Vendor:** ${opt.vendor_name} (${opt.vendor_id})  `,
    `**Quote ref:** ${q.quote_id} rev ${q.revision}  `,
    `**Delivery:** ${opt.delivery_date} (required on site ${REQUIRED_ON_SITE})  `,
    `**Status:** DRAFT`,
    '',
    '## Line items',
    '',
    '| # | Item | Description | Qty | Unit price | Amount |',
    '|---:|---|---|---:|---:|---:|',
    ...lines.map((l) => `| ${l.line_no} | \`${l.item_code}\` | ${l.description} | ${l.qty} | ${inrFull(l.unit_price_inr)} | ${inrFull(l.total_inr)} |`),
    '',
    '## Totals',
    '',
    '| | Amount |',
    '|---|---:|',
    `| Subtotal | ${inrFull(subtotal)} |`,
    `| Freight (to site) | ${inrFull(q.freight_inr)} |`,
    `| Expedite fee | ${inrFull(opt.expedite_fee_inr)} |`,
    `| GST 18 % | ${inrFull(gst)} |`,
    `| **Total** | **${inrFull(total)}** |`,
    '',
    '## Commercial terms',
    '',
    '- **Payment:** 10 % advance against ABG, 80 % on delivery, 10 % on commissioning',
    '- **Incoterms:** DAP Chakan MIDC (Incoterms 2020)',
    ...terms.map((x) => `- ${x}`),
    '',
    '## Approvals',
    '',
    '- Vendor selection approved by project.manager@alpha',
    '- PO release approved by project.manager@alpha',
    '',
    '> Generated by SiteMind. Every figure traces to the audit trail; the dispatch is idempotent (ledger key `po.sent`).',
  ].join('\n')
  return {
    po_number: poNumber,
    vendor_id: opt.vendor_id,
    vendor_name: opt.vendor_name,
    project: s.goal.project,
    lines,
    subtotal_inr: subtotal,
    freight_inr: q.freight_inr,
    expedite_fee_inr: opt.expedite_fee_inr,
    gst_inr: gst,
    total_inr: total,
    delivery_date: opt.delivery_date,
    payment_terms: '10 % advance against ABG, 80 % on delivery, 10 % on commissioning',
    incoterms: 'DAP Chakan MIDC (Incoterms 2020)',
    terms,
    status: 'draft',
    issued_at: null,
    markdown: md.replace('**Status:** DRAFT', '**Status:** DRAFT') + `\n\n_Drafted ${isoIST(now).slice(0, 10)}_`,
  }
}

export const TOTAL_STEPS = STEPS.length
