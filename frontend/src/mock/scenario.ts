// Deterministic Project Alpha demo scenario data used by the in-browser mock backend.
// Specialist numbers come from specialists.json (generated from the real backend specialists).
import type { CreateRunRequest } from '../types'

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

export const CONTINGENCY = 0.05
