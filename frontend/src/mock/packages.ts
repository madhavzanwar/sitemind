// Mock package catalogue (mirrors backend `PackageSpec`) + the scripted "story" each demo follows.
import type {
  BudgetCheck,
  CreateRunRequest,
  DecisionMemo,
  EventTypeSpec,
  PackageSpec,
  PurchaseOrder,
  Quote,
  ScheduleResult,
  TakeoffResult,
  VendorAttempt,
  VendorOption,
} from '../types'
import swgr from './data/swgr-480v.json'
import dg from './data/dg-2mw.json'

export interface MockData {
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

export interface Story {
  data: MockData
  short: Record<string, string> // vendor id -> short name
  timeouts: Record<string, number>
  docMissing?: { vendor: string; doc: string }
  revise: { vendor: string; reason: string }
  alt: { kind: 'expedite'; vendor: string } | { kind: 'slip'; vendor: string; days: number }
  rosLabel: string
  poNumber: string
}

export const PACKAGES: PackageSpec[] = [
  {
    package_id: 'swgr-480v',
    title: '480 V switchgear',
    description: 'Main LV switchgear line-ups, tie and feeder breakers, ATS, PQ meters, SPDs and Cu busway for the 24 MW data hall.',
    keywords: ['switchgear', 'switchboard', '480 v', 'lv panel', 'acb', 'busway'],
    spec_document: 'project_alpha_480V_switchgear_spec.pdf',
    vendor_ids: ['V1', 'V2', 'V3'],
    default_goal_text: 'Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr',
    default_project: 'Project Alpha',
    default_need_by: '2027-03-15',
    default_budget_inr: 46_000_000,
    required_on_site: '2027-07-30',
  },
  {
    package_id: 'dg-2mw',
    title: '2 MW DG sets',
    description: '4 × 2 MW 11 kV diesel generator sets with acoustic enclosures, day tanks, synchronising panel, stacks, NGRs and cabling.',
    keywords: ['dg', 'genset', 'generator', 'diesel', '2 mw'],
    spec_document: 'dg_2mw_genset_spec.pdf',
    vendor_ids: ['D1', 'D2', 'D3'],
    default_goal_text: 'Get the 2 MW DG sets for Project Alpha ordered by 2027-04-30 within budget ₹38 Cr',
    default_project: 'Project Alpha',
    default_need_by: '2027-04-30',
    default_budget_inr: 380_000_000,
    required_on_site: '2027-11-15',
  },
]

export const STORIES: Record<string, Story> = {
  'swgr-480v': {
    data: swgr as unknown as MockData,
    short: { V1: 'Voltaris', V2: 'Kestrel', V3: 'Anvil' },
    timeouts: { V1: 2 },
    revise: { vendor: 'V2', reason: 'copper surcharge, 3 % discount withdrawn' },
    alt: { kind: 'expedite', vendor: 'V3' },
    rosLabel: '30 Jul energisation window',
    poNumber: 'PO-ALPHA-SWGR-0001',
  },
  'dg-2mw': {
    data: dg as unknown as MockData,
    short: { D1: 'Brahmaputra', D2: 'Coromandel', D3: 'Saurashtra' },
    timeouts: {},
    docMissing: { vendor: 'D1', doc: 'CPCB IV+ emissions certificate' },
    revise: { vendor: 'D2', reason: 'USD/INR movement and steel escalation' },
    alt: { kind: 'slip', vendor: 'D3', days: 45 },
    rosLabel: '15 Nov 2027 DG commissioning window',
    poNumber: 'PO-ALPHA-DG-0001',
  },
}

export function packageById(id: string | undefined | null): PackageSpec {
  return PACKAGES.find((p) => p.package_id === id) ?? PACKAGES[0]!
}

export function defaultsFor(packageId?: string): CreateRunRequest {
  const p = packageById(packageId)
  return {
    goal_text: p.default_goal_text,
    project: p.default_project,
    package: p.title,
    need_by: p.default_need_by,
    budget_inr: p.default_budget_inr,
    scenario: 'demo',
    step_delay_s: null,
    auto_start: true,
    package_id: p.package_id,
    spec_upload_id: null,
  }
}

export const EVENT_TYPES: EventTypeSpec[] = [
  {
    type: 'price_change',
    title: 'Price change',
    description: 'A vendor revises its quote (surcharge, forex, discount withdrawn).',
    needs_vendor: true,
    params: [{ name: 'pct', label: 'Change', kind: 'float', default: 8, choices: [], unit: '%', min: -30, max: 50 }],
  },
  {
    type: 'vendor_late_reply',
    title: 'Vendor replies late',
    description: "The vendor's next reply arrives N sim days later than expected.",
    needs_vendor: true,
    params: [{ name: 'days', label: 'Delay', kind: 'int', default: 3, choices: [], unit: 'days', min: 1, max: 30 }],
  },
  {
    type: 'date_slip',
    title: 'Date slip',
    description: "A vendor's lead time slips, or the required-on-site date moves.",
    needs_vendor: false,
    params: [
      { name: 'days', label: 'Slip', kind: 'int', default: 21, choices: [], unit: 'days', min: -60, max: 120 },
      { name: 'target', label: 'Applies to', kind: 'choice', default: 'lead_time', choices: ['lead_time', 'required_on_site'], unit: '', min: null, max: null },
    ],
  },
  {
    type: 'document_missing',
    title: 'Missing document',
    description: 'A vendor submittal is incomplete; the PO cannot be released to them until it arrives.',
    needs_vendor: true,
    params: [{ name: 'document', label: 'Document', kind: 'text', default: 'Type-test certificate', choices: [], unit: '', min: null, max: null }],
  },
  {
    type: 'tool_failure',
    title: 'Tool failure',
    description: 'The next N calls to a specialist fail; the agent retries with backoff, then escalates.',
    needs_vendor: false,
    params: [
      { name: 'tool', label: 'Specialist', kind: 'choice', default: 'quotes', choices: ['quotes', 'schedule', 'budget', 'po'], unit: '', min: null, max: null },
      { name: 'count', label: 'Failures', kind: 'int', default: 2, choices: [], unit: 'calls', min: 1, max: 5 },
    ],
  },
  {
    type: 'approver_unavailable',
    title: 'Approver away',
    description: 'The approver is unavailable; the agent sends a reminder and delegation note instead of acting alone.',
    needs_vendor: false,
    params: [{ name: 'days', label: 'Away for', kind: 'int', default: 3, choices: [], unit: 'days', min: 1, max: 14 }],
  },
  {
    type: 'restart',
    title: 'Restart worker',
    description: 'SIGKILL the worker process and resume from the last checkpoint.',
    needs_vendor: false,
    params: [],
  },
]
