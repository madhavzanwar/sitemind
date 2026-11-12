import { useEffect, useState } from 'react'
import { ArrowRight, Brain, Calculator, CalendarRange, FileSignature, FileText, Hand, History, Loader2, MessageSquareQuote, Rocket, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import type { CreateRunRequest, RunSnapshot, SpecialistSpec } from '../types'
import { api } from '../api'
import { cx, fullDate, inr, inrWords, simClock } from '../lib/format'
import { RUN_STATUS, TONE } from '../lib/status'
import { Button, Label } from './ui'
import { Logo } from './Logo'

const ICONS: Record<string, LucideIcon> = {
  planner: Brain,
  takeoff: FileText,
  quotes: MessageSquareQuote,
  schedule: CalendarRange,
  budget: Calculator,
  approvals: Hand,
  po: FileSignature,
}

export function Composer({ onLaunched, onOpen }: { onLaunched: (s: RunSnapshot) => void; onOpen: (id: string) => void }) {
  const [form, setForm] = useState<CreateRunRequest | null>(null)
  const [budgetText, setBudgetText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [registry, setRegistry] = useState<SpecialistSpec[]>([])
  const [runs, setRuns] = useState<RunSnapshot[]>([])

  useEffect(() => {
    api
      .defaults()
      .then((d) => {
        setForm(d)
        setBudgetText(Math.round(d.budget_inr).toLocaleString('en-IN'))
      })
      .catch((e: unknown) => {
        setErr(`Backend unreachable: ${e instanceof Error ? e.message : String(e)}`)
        setForm({
          goal_text: 'Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr',
          need_by: '2027-03-15',
          budget_inr: 46_000_000,
          scenario: 'demo',
        })
        setBudgetText('4,60,00,000')
      })
    api.registry().then(setRegistry).catch(() => undefined)
    api.listRuns().then(setRuns).catch(() => undefined)
  }, [])

  const launch = async () => {
    if (!form) return
    setBusy(true)
    setErr(null)
    try {
      const s = await api.createRun({ ...form, auto_start: true })
      onLaunched(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const specs = registry.length ? registry : Object.keys(ICONS).map((n) => ({ name: n, title: n, description: '' }) as SpecialistSpec)

  return (
    <div className="mx-auto flex h-full w-full max-w-[1320px] flex-col justify-center gap-10 px-8 py-10">
      <div className="flex items-center gap-4 animate-fade-up">
        <Logo size={52} />
        <div>
          <div className="text-[13px] font-semibold uppercase tracking-[0.2em] text-accent-400">SiteMind · durable procurement agent</div>
          <h1 className="mt-1 text-[40px] font-semibold leading-[1.05] tracking-tight text-ink-50">
            Give it a goal. <span className="text-ink-400">It plans, chases vendors, survives crashes,</span> and asks you before it spends.
          </h1>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
        <section className="card animate-fade-up p-7 [animation-delay:60ms]">
          <Label>Goal</Label>
          <textarea
            data-testid="goal-input"
            value={form?.goal_text ?? ''}
            onChange={(e) => form && setForm({ ...form, goal_text: e.target.value })}
            rows={3}
            className="field mt-2 resize-none text-[17px] leading-relaxed"
            placeholder="Describe the procurement outcome…"
          />
          <div className="mt-5 grid grid-cols-3 gap-4">
            <label className="block">
              <Label>PO need-by date</Label>
              <input
                data-testid="need-by-input"
                type="date"
                value={form?.need_by ?? ''}
                onChange={(e) => form && setForm({ ...form, need_by: e.target.value })}
                className="field num mt-2"
              />
              <div className="mt-1.5 text-[11.5px] text-ink-400">{form?.need_by ? fullDate(form.need_by) : ''}</div>
            </label>
            <label className="block">
              <Label>Budget ceiling (₹)</Label>
              <input
                data-testid="budget-input"
                inputMode="numeric"
                value={budgetText}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^\d]/g, ''))
                  setBudgetText(n ? n.toLocaleString('en-IN') : '')
                  if (form) setForm({ ...form, budget_inr: n })
                }}
                className="field num mt-2"
              />
              <div className="mt-1.5 truncate text-[11.5px] text-ink-400">
                <span className="text-accent-300">{form ? inr(form.budget_inr) : ''}</span> {form ? `· ${inrWords(form.budget_inr)}` : ''}
              </div>
            </label>
            <label className="block">
              <Label>Scenario</Label>
              <select
                data-testid="scenario-select"
                value={form?.scenario ?? 'demo'}
                onChange={(e) => form && setForm({ ...form, scenario: e.target.value as 'demo' | 'happy' })}
                className="field mt-2"
              >
                <option value="demo">Demo — injected chaos</option>
                <option value="happy">Happy path — no failures</option>
              </select>
              <div className="mt-1.5 text-[11.5px] text-ink-400">
                {form?.scenario === 'happy' ? 'All vendors answer first time.' : 'Timeouts, price revision, late vendor.'}
              </div>
            </label>
          </div>
          <div className="mt-7 flex items-center gap-4">
            <Button data-testid="launch-button" variant="primary" size="lg" icon={busy ? Loader2 : Rocket} disabled={!form || busy} onClick={() => void launch()} className={cx(busy && '[&>svg]:animate-spin', 'px-6')}>
              Launch agent
            </Button>
            <div className="text-[12.5px] text-ink-400">
              {form?.project ?? 'Project Alpha'} · {form?.package ?? '480 V switchgear'} · sim starts Mon 11 Jan 2027
            </div>
          </div>
          {err && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200">{err}</div>}
        </section>

        <section className="card flex animate-fade-up flex-col p-7 [animation-delay:120ms]">
          <Label>Specialist crew</Label>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {specs.map((s) => {
              const I = ICONS[s.name] ?? Brain
              return (
                <div key={s.name} className="flex items-start gap-3 rounded-xl border border-white/[0.05] bg-ink-850/60 p-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-400/10 text-accent-300 ring-1 ring-inset ring-accent-400/20">
                    <I className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold capitalize text-ink-50">{s.title}</div>
                    <div className="line-clamp-2 text-[11.5px] leading-snug text-ink-400">{s.description}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-5 text-[12px]">
            <Feature icon={ShieldCheck} title="Durable" text="Checkpoint after every task" />
            <Feature icon={Zap} title="Idempotent" text="Side effects run once" />
            <Feature icon={Hand} title="Human-gated" text="You approve spend" />
          </div>
        </section>
      </div>

      {runs.length > 0 && (
        <section className="animate-fade-up [animation-delay:180ms]">
          <div className="mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-ink-400" />
            <Label>Recent runs</Label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {runs.slice(-6).reverse().map((r) => {
              const st = RUN_STATUS[r.status]
              return (
                <button key={r.run_id} onClick={() => onOpen(r.run_id)} className="card group flex items-center gap-3 p-4 text-left transition hover:border-white/15">
                  <span className={cx('h-2 w-2 rounded-full', TONE[st.tone].dot)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink-100">{r.goal.text}</div>
                    <div className="num mt-0.5 text-[11px] text-ink-400">
                      {r.run_id} · {st.label} · {simClock(r.sim_now)}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-ink-500 transition group-hover:translate-x-0.5 group-hover:text-ink-200" />
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

function Feature({ icon: I, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 font-semibold text-ink-100">
        <I className="h-3.5 w-3.5 text-accent-400" />
        {title}
      </div>
      <div className="mt-0.5 text-ink-400">{text}</div>
    </div>
  )
}
