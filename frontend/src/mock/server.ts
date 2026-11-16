// Mock implementation of the SiteMind REST API (VITE_MOCK=1). Runs progress in-browser on a timer.
import type {
  ApprovalDecision,
  CreateRunRequest,
  EventTypeSpec,
  GoalParseResult,
  Health,
  InjectEventRequest,
  PackageSpec,
  RunSnapshot,
  SpecialistSpec,
  SpecUpload,
} from '../types'
import { MockEngine } from './engine'
import { defaultsFor, EVENT_TYPES, PACKAGES, STORIES } from './packages'
import { parseGoal } from './parse'

export type FixtureStage = 'planning' | 'quotes' | 'replan' | 'approval' | 'killed' | 'po-approval' | 'completed' | 'event' | 'dg-approval' | 'dg-completed'

const runs = new Map<string, MockEngine>()
const timers = new Map<string, number>()
let runSeq = 0

const clone = <T,>(x: T): T => structuredClone(x)

function schedule(id: string, delayMs: number) {
  if (timers.has(id)) return
  const h = window.setInterval(() => runs.get(id)?.tick(), delayMs)
  timers.set(id, h)
}

function newEngine(req: CreateRunRequest): MockEngine {
  runSeq++
  const id = `run-${(Date.now() % 1e6).toString(36)}${runSeq}`
  const e = new MockEngine(id, req)
  runs.set(id, e)
  return e
}

/** Run an engine synchronously to a named stage (fixtures + screenshots). */
export function buildFixture(stage: FixtureStage): MockEngine {
  const dg = stage.startsWith('dg-')
  const e = newEngine(defaultsFor(dg ? 'dg-2mw' : 'swgr-480v'))
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) e.tick()
  }
  const approve = (kind: 'vendor_selection' | 'po_release', comment?: string) => {
    const a = e.snap.approvals.find((x) => x.kind === kind && x.status === 'pending')
    if (a) e.decide(a.id, { decision: 'approve', option_id: a.memo?.recommendation ?? null, comment })
  }
  const crash = () => {
    ticks(6)
    e.kill()
    e.resume()
  }
  switch (stage) {
    case 'planning':
      ticks(2)
      break
    case 'quotes':
      ticks(5)
      break
    case 'replan':
      ticks(10)
      break
    case 'approval':
      crash()
      ticks(20)
      break
    case 'killed':
      crash()
      ticks(5)
      e.kill()
      break
    case 'event': {
      crash()
      ticks(20)
      const rec = e.snap.options.find((o) => o.recommended)
      e.inject({ type: 'price_change', vendor_id: rec?.vendor_id, params: { pct: 12 }, note: 'Steel surcharge notified by phone' })
      e.inject({ type: 'approver_unavailable', params: { days: 2 } })
      ticks(1)
      e.inject({ type: 'vendor_late_reply', vendor_id: 'V1', params: { days: 4 } })
      break
    }
    case 'po-approval':
      crash()
      ticks(20)
      approve('vendor_selection', 'Approved — tie any expedite fee to the delivery milestone.')
      ticks(5)
      break
    case 'completed':
    case 'dg-completed':
      crash()
      ticks(20)
      approve('vendor_selection', 'Approved — tie any expedite fee to the delivery milestone.')
      ticks(5)
      approve('po_release', 'Released.')
      ticks(5)
      break
    case 'dg-approval':
      ticks(20)
      break
  }
  return e
}

const delayMs = () => {
  const q = new URLSearchParams(window.location.search).get('mock_delay')
  return q ? Number(q) : 1200
}

const REGISTRY: SpecialistSpec[] = [
  { name: 'planner', title: 'Planner', description: 'Turns the goal into a task plan with risks; re-plans when the world changes', inputs: ['Goal'], outputs: ['Plan'], deterministic: false, side_effects: false, mcp_tool: 'plan_goal' },
  { name: 'takeoff', title: 'Spec takeoff', description: 'Reads the spec PDF into a cited bill of quantities', inputs: ['pdf'], outputs: ['TakeoffResult'], deterministic: true, side_effects: false, mcp_tool: 'takeoff_from_pdf' },
  { name: 'quotes', title: 'Quotes', description: 'Sends RFQs, retries silent vendors, levels the bids', inputs: ['TakeoffLine[]'], outputs: ['QuotesResult'], deterministic: true, side_effects: true, mcp_tool: 'request_vendor_quotes' },
  { name: 'schedule', title: 'Schedule', description: 'Critical-path float for every vendor against the site date', inputs: ['Quote'], outputs: ['ScheduleResult'], deterministic: true, side_effects: false, mcp_tool: 'compute_schedule' },
  { name: 'budget', title: 'Budget', description: 'Commitment vs ceiling, with contingency', inputs: ['Quote'], outputs: ['BudgetCheck'], deterministic: true, side_effects: false, mcp_tool: 'check_budget' },
  { name: 'approvals', title: 'Approvals', description: 'Ranks options and writes the decision memo', inputs: ['VendorOption[]'], outputs: ['DecisionMemo'], deterministic: false, side_effects: true, mcp_tool: 'rank_vendor_options' },
  { name: 'po', title: 'Purchase order', description: 'Drafts the PO and sends it exactly once', inputs: ['VendorOption'], outputs: ['PurchaseOrder'], deterministic: true, side_effects: true, mcp_tool: 'draft_purchase_order' },
]

function get(id: string): MockEngine {
  const e = runs.get(id)
  if (!e) throw new Error(`run ${id} not found`)
  return e
}

let uploadSeq = 0

export const mockApi = {
  async health(): Promise<Health> {
    return { status: 'ok', llm: { provider: 'ollama', model: 'qwen2.5:3b', reachable: true } }
  },
  async registry(): Promise<SpecialistSpec[]> {
    return REGISTRY
  },
  async defaults(packageId?: string): Promise<CreateRunRequest> {
    return defaultsFor(packageId)
  },
  async packages(): Promise<PackageSpec[]> {
    return clone(PACKAGES)
  },
  async parseGoal(text: string): Promise<GoalParseResult> {
    await new Promise((r) => setTimeout(r, 120))
    return parseGoal(text)
  },
  async uploadSpec(file: File): Promise<SpecUpload> {
    await new Promise((r) => setTimeout(r, 700))
    const name = file.name.toLowerCase()
    const pkg = /dg|gen|diesel/.test(name) ? 'dg-2mw' : 'swgr-480v'
    const tk = clone(STORIES[pkg]!.data.takeoff)
    tk.document = file.name
    tk.lines = tk.lines.map((l) => ({ ...l, source: l.source.replace(/^[^ ]+/, file.name) }))
    tk.confidence = Math.max(0.6, tk.confidence - 0.07)
    tk.warnings = [...tk.warnings, 'Uploaded document: table headers mapped by name (item, description, qty, unit, rating); please review quantities.']
    return { upload_id: `up-${++uploadSeq}`, filename: file.name, pages: 4, size_bytes: file.size, package_id: pkg, takeoff: tk }
  },
  async eventTypes(): Promise<EventTypeSpec[]> {
    return clone(EVENT_TYPES)
  },
  async injectEvent(id: string, body: InjectEventRequest): Promise<RunSnapshot> {
    const e = get(id)
    e.inject(body)
    if (e.snap.status !== 'completed') e.tick()
    schedule(id, delayMs())
    return clone(e.snap)
  },
  async listRuns(): Promise<RunSnapshot[]> {
    return [...runs.values()].map((e) => clone(e.snap))
  },
  async createRun(req: CreateRunRequest): Promise<RunSnapshot> {
    const e = newEngine(req)
    if (req.auto_start !== false) {
      e.tick()
      schedule(e.snap.run_id, req.step_delay_s ? req.step_delay_s * 1000 : delayMs())
    }
    return clone(e.snap)
  },
  async getRun(id: string): Promise<RunSnapshot> {
    return clone(get(id).snap)
  },
  async kill(id: string): Promise<RunSnapshot> {
    const e = get(id)
    e.kill()
    return clone(e.snap)
  },
  async resume(id: string): Promise<RunSnapshot> {
    const e = get(id)
    e.resume()
    schedule(id, delayMs())
    return clone(e.snap)
  },
  async decide(id: string, approvalId: string, d: ApprovalDecision): Promise<RunSnapshot> {
    const e = get(id)
    e.decide(approvalId, d)
    schedule(id, delayMs())
    return clone(e.snap)
  },
  async poMarkdown(id: string): Promise<string> {
    return get(id).snap.po?.markdown ?? ''
  },
  /** Preload a fixture run (paused unless `live`). Returns its id. */
  loadFixture(stage: FixtureStage, live = false): string {
    const e = buildFixture(stage)
    if (live && e.snap.status !== 'completed') schedule(e.snap.run_id, delayMs())
    return e.snap.run_id
  },
}
