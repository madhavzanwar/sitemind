// Deterministic Project Alpha demo scenario data used by the in-browser mock backend.
// Mirrors docs/CONTRACT.md: V1 times out twice, V2 revises +11 % (budget breach -> re-plan v2),
// V3 breaks the deadline but offers a 42-day expedite for a fee.
import type { CreateRunRequest, TakeoffLine } from '../types'

export const DEFAULT_GOAL_TEXT =
  'Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr'

export const DEFAULTS: CreateRunRequest = {
  goal_text: DEFAULT_GOAL_TEXT,
  project: 'Project Alpha',
  package: '480 V switchgear',
  need_by: '2027-03-15',
  budget_inr: 46_000_000,
  scenario: 'demo',
  step_delay_s: null,
  auto_start: true,
}

export const REQUIRED_ON_SITE = '2027-07-30'
export const SIM_START = '2027-01-11T09:00:00+05:30'

export const TAKEOFF_LINES: TakeoffLine[] = [
  { item_code: 'SWGR-MAIN-4000A', description: '480 V main switchboard section, Form 4b Type 6', qty: 4, unit: 'ea', rating: '4000 A, 65 kA/1 s', source: 'spec.pdf p2 table 1' },
  { item_code: 'SWGR-TIE-4000A', description: 'Bus-tie section with draw-out ACB', qty: 2, unit: 'ea', rating: '4000 A, 65 kA', source: 'spec.pdf p2 table 1' },
  { item_code: 'SWGR-DIST-1600A', description: 'Distribution section, MCCB feeders', qty: 8, unit: 'ea', rating: '1600 A, 50 kA', source: 'spec.pdf p3 table 2' },
  { item_code: 'ACB-4000A-DO', description: 'Draw-out air circuit breaker, 3P, LSIG trip', qty: 6, unit: 'ea', rating: '4000 A, 65 kA', source: 'spec.pdf p3 table 2' },
  { item_code: 'MCCB-800A', description: 'Moulded-case breaker, electronic trip unit', qty: 48, unit: 'ea', rating: '800 A, 50 kA', source: 'spec.pdf p4 table 3' },
  { item_code: 'BUSDUCT-4000A', description: 'Sandwich busduct, copper, IP54', qty: 120, unit: 'm', rating: '4000 A', source: 'spec.pdf p4 §4.2' },
  { item_code: 'PQM-CL02S', description: 'Power-quality meter, Modbus TCP', qty: 12, unit: 'ea', rating: 'Class 0.2S', source: 'spec.pdf p5 §5.1' },
]

/** V1 base unit prices (INR). Other vendors apply a multiplier. */
export const BASE_UNIT_PRICE: Record<string, number> = {
  'SWGR-MAIN-4000A': 3_850_000,
  'SWGR-TIE-4000A': 2_100_000,
  'SWGR-DIST-1600A': 980_000,
  'ACB-4000A-DO': 640_000,
  'MCCB-800A': 62_000,
  'BUSDUCT-4000A': 28_500,
  'PQM-CL02S': 58_000,
}

export interface VendorProfile {
  id: string
  name: string
  city: string
  reliability: number
  lead: number
  mult: number
  freight: number
}

export const VENDORS: VendorProfile[] = [
  { id: 'V1', name: 'Voltaris Switchgear Pvt Ltd', city: 'Nashik', reliability: 0.82, lead: 140, mult: 1.0, freight: 450_000 },
  { id: 'V2', name: 'Kestrel Power Systems', city: 'Vadodara', reliability: 0.93, lead: 112, mult: 1.072, freight: 320_000 },
  { id: 'V3', name: 'Anvil Electric India', city: 'Chennai', reliability: 0.9, lead: 168, mult: 1.035, freight: 680_000 },
]

export const V2_REVISION = 0.11
export const V3_EXPEDITE_DAYS = 42
export const V3_EXPEDITE_FEE = 1_850_000
export const CONTINGENCY = 0.05
/** submittals 14 + approval 7 + FAT 7 + shipping 6 */
export const NON_MFG_DAYS = 34
export const PROJECTED_PO_ISSUE = '2027-01-29'
