// Mock implementation of the SiteMind REST API (VITE_MOCK=1). Runs progress in-browser on a timer.
import type { ApprovalDecision, CreateRunRequest, Health, RunSnapshot, SpecialistSpec } from '../types'
import { MockEngine } from './engine'
import { DEFAULTS } from './scenario'

export type FixtureStage = 'planning' | 'quotes' | 'replan' | 'approval' | 'killed' | 'po-approval' | 'completed'

const runs = new Map<string, MockEngine>()
const timers = new Map<string, number>()
let runSeq = 0

function clone<T>(x: T): T {
  return structuredClone(x)
}

function schedule(id: string, delayMs: number) {
  if (timers.has(id)) return
  const h = window.setInterval(() => {
    const e = runs.get(id)
    if (!e) return
    e.tick()
  }, delayMs)
  timers.set(id, h)
}

function newEngine(req: CreateRunRequest): MockEngine {
  runSeq++
  const id = `run-${(Date.now() % 1e6).toString(36)}${runSeq}`
  const e = new MockEngine(id, req)
  runs.set(id, e)
  return e
}

/** Run an engine synchronously to a named stage (used for fixtures + screenshots). */
export function buildFixture(stage: FixtureStage): MockEngine {
  const e = newEngine(DEFAULTS)
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) e.tick()
  }
  const approve = (kind: 'vendor_selection' | 'po_release', comment?: string) => {
    const a = e.snap.approvals.find((x) => x.kind === kind && x.status === 'pending')
    if (a) e.decide(a.id, { decision: 'approve', option_id: a.memo?.recommendation ?? null, comment })
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
      ticks(6)
      e.kill()
      e.resume()
      ticks(20)
      break
    case 'killed':
      ticks(6)
      e.kill()
      e.resume()
      ticks(5)
      e.kill()
      break
    case 'po-approval':
      ticks(6)
      e.kill()
      e.resume()
      ticks(20)
      approve('vendor_selection', 'Go with Anvil expedite — tie the ₹26 L fee to the delivery milestone.')
      ticks(5)
      break
    case 'completed':
      ticks(6)
      e.kill()
      e.resume()
      ticks(20)
      approve('vendor_selection', 'Go with Anvil expedite — tie the ₹26 L fee to the delivery milestone.')
      ticks(5)
      approve('po_release', 'Released.')
      ticks(5)
      break
  }
  return e
}

const delayMs = () => {
  const q = new URLSearchParams(window.location.search).get('mock_delay')
  return q ? Number(q) : 1200
}

const REGISTRY: SpecialistSpec[] = [
  { name: 'planner', title: 'Planner', description: 'Goal → task DAG, risks; re-plans on change', inputs: ['Goal'], outputs: ['Plan'], deterministic: false, side_effects: false, mcp_tool: 'plan_goal' },
  { name: 'takeoff', title: 'Spec / Takeoff', description: 'Extracts BOQ lines from spec PDF', inputs: ['pdf'], outputs: ['TakeoffResult'], deterministic: true, side_effects: false, mcp_tool: 'run_takeoff' },
  { name: 'quotes', title: 'Quotes', description: 'RFQs with retries', inputs: ['TakeoffLine[]'], outputs: ['QuotesResult'], deterministic: true, side_effects: true, mcp_tool: 'collect_quotes' },
  { name: 'schedule', title: 'Schedule', description: 'CPM float per vendor', inputs: ['Quote'], outputs: ['ScheduleResult'], deterministic: true, side_effects: false, mcp_tool: 'schedule_for_quote' },
  { name: 'budget', title: 'Budget', description: 'Budget verdict incl. contingency', inputs: ['Quote'], outputs: ['BudgetCheck'], deterministic: true, side_effects: false, mcp_tool: 'check_budget' },
  { name: 'approvals', title: 'Approvals', description: 'Ranks options, drafts decision memo', inputs: ['VendorOption[]'], outputs: ['DecisionMemo'], deterministic: false, side_effects: true, mcp_tool: 'build_decision_memo' },
  { name: 'po', title: 'Purchase Order', description: 'Drafts and sends the PO', inputs: ['VendorOption'], outputs: ['PurchaseOrder'], deterministic: true, side_effects: true, mcp_tool: 'draft_po' },
]

function get(id: string): MockEngine {
  const e = runs.get(id)
  if (!e) throw new Error(`run ${id} not found`)
  return e
}

export const mockApi = {
  async health(): Promise<Health> {
    return { status: 'ok', llm: { provider: 'ollama', model: 'qwen2.5:3b', reachable: true } }
  },
  async registry(): Promise<SpecialistSpec[]> {
    return REGISTRY
  },
  async defaults(): Promise<CreateRunRequest> {
    return clone(DEFAULTS)
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
    if (live && e.snap.status === 'running') schedule(e.snap.run_id, delayMs())
    return e.snap.run_id
  },
}
