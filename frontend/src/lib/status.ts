import type { RunStatus, TaskStatus, TimelineKind, Verdict } from '../types'

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  created: { label: 'Created', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  waiting_human: { label: 'Awaiting approval', tone: 'human' },
  killed: { label: 'Worker killed', tone: 'danger' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'human' | 'info'

export const TONE: Record<Tone, { text: string; bg: string; ring: string; dot: string; hex: string }> = {
  neutral: { text: 'text-ink-200', bg: 'bg-white/[0.04]', ring: 'ring-white/10', dot: 'bg-ink-300', hex: '#8A95A8' },
  accent: { text: 'text-accent-300', bg: 'bg-accent-400/10', ring: 'ring-accent-400/30', dot: 'bg-accent-400', hex: '#FFB224' },
  success: { text: 'text-emerald-300', bg: 'bg-emerald-400/10', ring: 'ring-emerald-400/25', dot: 'bg-emerald-400', hex: '#34D399' },
  warning: { text: 'text-orange-300', bg: 'bg-orange-400/10', ring: 'ring-orange-400/25', dot: 'bg-orange-400', hex: '#FB923C' },
  danger: { text: 'text-rose-300', bg: 'bg-rose-500/10', ring: 'ring-rose-400/30', dot: 'bg-rose-500', hex: '#F43F5E' },
  human: { text: 'text-violet-300', bg: 'bg-violet-400/10', ring: 'ring-violet-400/30', dot: 'bg-violet-400', hex: '#A78BFA' },
  info: { text: 'text-sky-300', bg: 'bg-sky-400/10', ring: 'ring-sky-400/25', dot: 'bg-sky-400', hex: '#38BDF8' },
}

export const TASK_TONE: Record<TaskStatus, Tone> = {
  pending: 'neutral',
  ready: 'info',
  running: 'accent',
  waiting_human: 'human',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
}

export const TASK_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  ready: 'Ready',
  running: 'Running',
  waiting_human: 'Needs human',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Superseded',
}

export const EVENT_TONE: Record<TimelineKind, Tone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
  human: 'human',
  kill: 'danger',
}

export const VERDICT_TONE: Record<Verdict, Tone> = { ok: 'success', warn: 'warning', breach: 'danger' }

export const LANES = ['planner', 'takeoff', 'quotes', 'schedule', 'budget', 'approvals', 'po', 'human', 'system'] as const

export const LANE_LABEL: Record<string, string> = {
  planner: 'Planner',
  takeoff: 'Takeoff',
  quotes: 'Quotes',
  schedule: 'Schedule',
  budget: 'Budget',
  approvals: 'Approvals',
  po: 'PO',
  human: 'Human',
  system: 'System',
}
