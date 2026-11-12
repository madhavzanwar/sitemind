// Typed mirror of backend/sitemind/models.py (pydantic v2). Do not rename fields.
// Dates are ISO strings: `date` -> "YYYY-MM-DD", `datetime` -> ISO-8601 timestamp.

export type ISODate = string
export type ISODateTime = string
export type JsonDict = Record<string, unknown>

// ------------------------------------------------------------------ goal
export interface Goal {
  text: string
  project: string
  package: string
  need_by: ISODate
  required_on_site: ISODate | null
  budget_inr: number
  currency: 'INR'
}

// ------------------------------------------------------------------ registry
export interface SpecialistSpec {
  name: string
  title: string
  description: string
  inputs: string[]
  outputs: string[]
  deterministic: boolean
  side_effects: boolean
  mcp_tool: string
}

// ------------------------------------------------------------------ plan
export type TaskStatus = 'pending' | 'ready' | 'running' | 'waiting_human' | 'done' | 'failed' | 'skipped'

export type Level = 'low' | 'medium' | 'high'

export interface Risk {
  id: string
  title: string
  likelihood: Level
  impact: Level
  mitigation: string
}

export interface PlanTask {
  id: string
  title: string
  specialist: string
  depends_on: string[]
  deadline: ISODate | null
  budget_inr: number
  status: TaskStatus
  attempts: number
  plan_version: number
  started_at: ISODateTime | null
  finished_at: ISODateTime | null
  output_ref: string | null
  note: string | null
}

export interface Plan {
  version: number
  tasks: PlanTask[]
  risks: Risk[]
  rationale: string
  created_at: ISODateTime
}

// ------------------------------------------------------------------ specialist outputs
export interface TakeoffLine {
  item_code: string
  description: string
  qty: number
  unit: string
  rating: string
  source: string
}

export interface TakeoffResult {
  document: string
  lines: TakeoffLine[]
  confidence: number
  warnings: string[]
}

export interface QuoteLine {
  item_code: string
  qty: number
  unit_price_inr: number
  total_inr: number
}

export type QuoteStatus = 'received' | 'revised' | 'timeout' | 'declined'

export interface Quote {
  vendor_id: string
  vendor_name: string
  quote_id: string
  revision: number
  lines: QuoteLine[]
  freight_inr: number
  total_inr: number
  lead_time_days: number
  valid_until: ISODate
  reliability: number
  status: QuoteStatus
  received_at: ISODateTime | null
  notes: string
}

export interface VendorAttempt {
  vendor_id: string
  attempt: number
  outcome: 'ok' | 'timeout' | 'revised' | 'declined'
  at: ISODateTime
  detail: string
}

export interface QuotesResult {
  quotes: Quote[]
  attempts: VendorAttempt[]
}

export interface ScheduleActivity {
  id: string
  name: string
  duration_days: number
  depends_on: string[]
  early_start: number
  early_finish: number
  late_start: number
  late_finish: number
  slack_days: number
  critical: boolean
}

export interface ScheduleResult {
  vendor_id: string
  activities: ScheduleActivity[]
  critical_path: string[]
  po_issue_date: ISODate
  delivery_date: ISODate
  required_on_site: ISODate
  float_days: number
  meets_deadline: boolean
}

export type Verdict = 'ok' | 'warn' | 'breach'

export interface BudgetCheck {
  vendor_id: string
  quote_total_inr: number
  contingency_inr: number
  committed_inr: number
  budget_inr: number
  headroom_inr: number
  utilisation: number
  verdict: Verdict
  reasons: string[]
}

export interface VendorOption {
  option_id: string
  vendor_id: string
  vendor_name: string
  total_inr: number
  lead_time_days: number
  delivery_date: ISODate
  float_days: number
  reliability: number
  expedite_fee_inr: number
  budget_verdict: Verdict
  meets_deadline: boolean
  score: number
  recommended: boolean
  rationale: string
}

export interface DecisionMemo {
  memo_id: string
  title: string
  situation: string
  options: VendorOption[]
  recommendation: string
  reasoning: string
  risks: string[]
  asks: string
}

export interface POLine {
  line_no: number
  item_code: string
  description: string
  qty: number
  unit_price_inr: number
  total_inr: number
}

export interface PurchaseOrder {
  po_number: string
  vendor_id: string
  vendor_name: string
  project: string
  lines: POLine[]
  subtotal_inr: number
  freight_inr: number
  expedite_fee_inr: number
  gst_inr: number
  total_inr: number
  delivery_date: ISODate
  payment_terms: string
  incoterms: string
  terms: string[]
  status: 'draft' | 'approved' | 'sent'
  issued_at: ISODateTime | null
  markdown: string
}

// ------------------------------------------------------------------ HITL
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
export type ApprovalKind = 'vendor_selection' | 'po_release' | 'budget_exception' | 'deadline_risk'

export interface ApprovalRequest {
  id: string
  run_id: string
  kind: ApprovalKind
  title: string
  summary: string
  memo: DecisionMemo | null
  po: PurchaseOrder | null
  options: string[]
  status: ApprovalStatus
  decided_option: string | null
  decided_by: string | null
  comment: string | null
  requested_at: ISODateTime
  decided_at: ISODateTime | null
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject'
  option_id?: string | null
  comment?: string | null
  decided_by?: string
}

// ------------------------------------------------------------------ audit / ledger
export interface AuditEntry {
  seq: number
  run_id: string
  sim_time: ISODateTime
  wall_time: ISODateTime
  actor: string
  action: string
  summary: string
  inputs: JsonDict
  outputs: JsonDict
  cost_inr: number
  llm_tokens: number
  confidence: number | null
  task_id: string | null
  plan_version: number | null
}

export interface LedgerEntry {
  idempotency_key: string
  run_id: string
  kind: string
  status: 'done'
  payload: JsonDict
  result: JsonDict
  sim_time: ISODateTime
  wall_time: ISODateTime
  executions: number
}

// ------------------------------------------------------------------ run snapshot
export type RunStatus = 'created' | 'running' | 'waiting_human' | 'killed' | 'completed' | 'failed'

export interface WorkerInfo {
  pid: number | null
  alive: boolean
  started_at: ISODateTime | null
  restarts: number
}

export interface BudgetPoint {
  sim_time: ISODateTime
  committed_inr: number
  forecast_inr: number
  [k: string]: unknown
}

export interface BudgetBurn {
  budget_inr: number
  committed_inr: number
  forecast_inr: number
  spent_process_inr: number
  points: BudgetPoint[]
}

export type TimelineKind = 'info' | 'success' | 'warning' | 'error' | 'human' | 'kill'

export interface TimelineEvent {
  sim_time: ISODateTime
  lane: string
  label: string
  kind: TimelineKind
}

export interface LlmInfo {
  provider?: string
  model?: string
  calls?: number
  [k: string]: unknown
}

export interface RunSnapshot {
  run_id: string
  goal: Goal
  status: RunStatus
  sim_now: ISODateTime
  sim_start: ISODateTime
  plan: Plan | null
  plan_history: Plan[]
  takeoff: TakeoffResult | null
  quotes: Quote[]
  vendor_attempts: VendorAttempt[]
  options: VendorOption[]
  schedule: ScheduleResult | null
  budget: BudgetBurn
  approvals: ApprovalRequest[]
  po: PurchaseOrder | null
  audit: AuditEntry[]
  ledger: LedgerEntry[]
  timeline: TimelineEvent[]
  worker: WorkerInfo
  checkpoints: number
  current_node: string | null
  llm: LlmInfo
  error: string | null
}

export interface CreateRunRequest {
  goal_text: string
  project?: string
  package?: string
  need_by: ISODate
  budget_inr: number
  scenario?: 'demo' | 'happy'
  step_delay_s?: number | null
  auto_start?: boolean
}

export interface Health {
  status: string
  llm: { provider: string; model: string; reachable: boolean }
}
