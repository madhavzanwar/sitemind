import type { AuditEntry, Plan } from '../types'

export function triggerFor(plan: Plan, audit: AuditEntry[]): string | null {
  const e = audit.find((a) => a.action.includes('replan') && (a.plan_version === plan.version || a.outputs?.version === plan.version))
  const trig = e?.inputs?.trigger ?? e?.outputs?.trigger
  if (typeof trig === 'string') return trig.replace(/_/g, ' ')
  const first = plan.rationale.split(/[.:;]/)[0]
  return first ? first.slice(0, 60) : null
}

