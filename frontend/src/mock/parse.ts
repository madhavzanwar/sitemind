// Deterministic goal parser for mock mode (mirrors the backend `parse_goal` contract):
// package via keywords, project ("Project X"), need-by date, budget — each with its evidence span.
// It never invents values: anything it cannot read is listed in `missing` with a question.
import type { GoalParseResult } from '../types'
import { PACKAGES } from './packages'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const mIdx = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)))
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function parseGoal(text: string): GoalParseResult {
  const t = text.trim()
  const lower = t.toLowerCase()
  const evidence: Record<string, string> = {}
  const missing: string[] = []
  const questions: string[] = []

  // package
  let best: { id: string; title: string; kw: string } | null = null
  for (const p of PACKAGES) {
    for (const kw of p.keywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      const m = t.match(re)
      if (m && (!best || kw.length > best.kw.length)) best = { id: p.package_id, title: p.title, kw: m[0] }
    }
  }
  // something that looks like a package we don't stock
  const other = t.match(/\b(chillers?|transformers?|ups|cooling towers?|crac units?|elevators?|lifts?|cables? trays?|fire pumps?)\b/i)
  let supported = true
  if (best) evidence.package = best.kw
  else if (other) {
    supported = false
    evidence.package = other[0]
    questions.push(`SiteMind has no vendor catalogue for “${other[0]}” yet. Shall I hand this goal to a procurement lead?`)
  } else {
    missing.push('package')
    questions.push('Which package should I buy? (e.g. 480 V switchgear, 2 MW DG sets)')
  }

  // project
  const pm = t.match(/\bProject\s+[A-Z][\w-]*/)
  const project = pm ? pm[0] : null
  if (pm) evidence.project = pm[0]
  else {
    missing.push('project')
    questions.push('Which project is this for?')
  }

  // need-by date
  let needBy: string | null = null
  const d1 = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/)
  const d2 = t.match(/\b(\d{1,2})\s+(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(20\d\d)\b/i)
  const d3 = t.match(/\b(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(\d{1,2}),?\s+(20\d\d)\b/i)
  if (d1) {
    needBy = d1[0]
    evidence.need_by = d1[0]
  } else if (d2) {
    needBy = iso(Number(d2[3]), mIdx(d2[2]!), Number(d2[1]))
    evidence.need_by = d2[0]
  } else if (d3) {
    needBy = iso(Number(d3[3]), mIdx(d3[1]!), Number(d3[2]))
    evidence.need_by = d3[0]
  } else {
    missing.push('need_by')
    questions.push('By when must the PO be issued?')
  }

  // budget
  let budget: number | null = null
  const num = (s: string) => Number(s.replace(/,/g, ''))
  const b1 = t.match(/(?:₹|rs\.?|inr)\s*([\d.,]+)\s*(cr(?:ore)?s?|lakhs?|lacs?|l)\b/i) ?? t.match(/\b([\d.,]+)\s*(crores?|cr|lakhs?|lacs?)\b/i)
  const b2 = t.match(/(?:₹|rs\.?|inr)\s*([\d,]{5,})\b/i)
  if (b1) {
    const unit = b1[2]!.toLowerCase()
    budget = num(b1[1]!) * (unit.startsWith('c') ? 1e7 : 1e5)
    evidence.budget_inr = b1[0]
  } else if (b2) {
    budget = num(b2[1]!)
    evidence.budget_inr = b2[0]
  } else {
    missing.push('budget_inr')
    questions.push('What is the budget ceiling (ex-GST)?')
  }

  const found = 4 - missing.length
  return {
    package_id: best?.id ?? null,
    package: best?.title ?? (other ? other[0] : null),
    project,
    need_by: needBy,
    budget_inr: budget ? Math.round(budget) : null,
    confidence: Math.round((found / 4) * (supported ? 0.95 : 0.6) * 100) / 100,
    evidence,
    missing,
    questions: lower ? questions : ['Describe what you need ordered, by when, and the budget.'],
    supported,
  }
}
