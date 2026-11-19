import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Fuel,
  History,
  Loader2,
  MessageSquareText,
  Rocket,
  ShieldCheck,
  Upload,
  UserRound,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { CreateRunRequest, GoalParseResult, PackageSpec, RunSnapshot, SpecUpload } from '../types'
import { api } from '../api'
import { cx, fullDate, inr, inrWords, simClock } from '../lib/format'
import { RUN_STATUS, TONE } from '../lib/status'
import { Button, Confidence } from './ui'

const PKG_ICON: Record<string, LucideIcon> = { 'swgr-480v': Zap, 'dg-2mw': Fuel }

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: MessageSquareText, title: 'Describe the outcome', text: 'Plain English. SiteMind shows exactly where it read the package, date and budget.' },
  { icon: Workflow, title: 'The agent does the legwork', text: 'Reads the spec, chases vendors, re-plans when prices or dates move — and survives crashes.' },
  { icon: ShieldCheck, title: 'You make the calls', text: 'Nothing is spent without your approval; the PO is sent exactly once.' },
]

const FIELD_LABEL: Record<string, string> = { package: 'Package', project: 'Project', need_by: 'Need-by', budget_inr: 'Budget' }

export function Composer({ onLaunched, onOpen }: { onLaunched: (s: RunSnapshot) => void; onOpen: (id: string) => void }) {
  const [packages, setPackages] = useState<PackageSpec[]>([])
  const [goal, setGoal] = useState('')
  const [pkgId, setPkgId] = useState('swgr-480v')
  const [needBy, setNeedBy] = useState('')
  const [budget, setBudget] = useState(0)
  const [scenario, setScenario] = useState<'demo' | 'happy'>('demo')
  const [parse, setParse] = useState<GoalParseResult | null>(null)
  const [parsing, setParsing] = useState(false)
  const [specMode, setSpecMode] = useState<'sample' | 'upload'>('sample')
  const [upload, setUpload] = useState<SpecUpload | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSnapshot[]>([])
  const [handedOff, setHandedOff] = useState(false)
  const touched = useRef({ needBy: false, budget: false, pkg: false })
  const fileRef = useRef<HTMLInputElement>(null)

  const applyDefaults = (d: CreateRunRequest) => {
    setGoal(d.goal_text)
    setNeedBy(d.need_by)
    setBudget(d.budget_inr)
    setPkgId(d.package_id ?? 'swgr-480v')
    touched.current = { needBy: false, budget: false, pkg: false }
  }

  useEffect(() => {
    api
      .defaults()
      .then(applyDefaults)
      .catch((e: unknown) => {
        setErr(`Backend unreachable: ${e instanceof Error ? e.message : String(e)}`)
        setGoal('Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr')
        setNeedBy('2027-03-15')
        setBudget(46_000_000)
      })
    api.packages().then(setPackages).catch(() => undefined)
    api.listRuns().then(setRuns).catch(() => undefined)
  }, [])

  // live, debounced goal parsing
  useEffect(() => {
    if (!goal.trim()) {
      setParse(null)
      return
    }
    setParsing(true)
    const h = window.setTimeout(() => {
      api
        .parseGoal(goal)
        .then((r) => {
          setParse(r)
          if (r.package_id && !touched.current.pkg) setPkgId(r.package_id)
          if (r.need_by && !touched.current.needBy) setNeedBy(r.need_by)
          if (r.budget_inr && !touched.current.budget) setBudget(r.budget_inr)
        })
        .catch(() => setParse(null))
        .finally(() => setParsing(false))
    }, 350)
    return () => window.clearTimeout(h)
  }, [goal])

  const pkg = packages.find((p) => p.package_id === pkgId)
  const unsupported = parse?.supported === false

  const pickPackage = (p: PackageSpec) => {
    setGoal(p.default_goal_text)
    setNeedBy(p.default_need_by)
    setBudget(p.default_budget_inr)
    setPkgId(p.package_id)
    setUpload(null)
    setSpecMode('sample')
    setHandedOff(false)
    touched.current = { needBy: false, budget: false, pkg: false }
  }

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setSpecMode('upload')
    setUploading(true)
    setErr(null)
    try {
      const u = await api.uploadSpec(f)
      setUpload(u)
      if (u.package_id && !touched.current.pkg) setPkgId(u.package_id)
    } catch (e) {
      setErr(`Upload failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  const launch = async () => {
    setBusy(true)
    setErr(null)
    try {
      const s = await api.createRun({
        goal_text: goal,
        project: parse?.project ?? pkg?.default_project ?? 'Project Alpha',
        package: pkg?.title ?? parse?.package ?? '480 V switchgear',
        need_by: needBy,
        budget_inr: budget,
        scenario,
        auto_start: true,
        package_id: pkgId,
        spec_upload_id: specMode === 'upload' ? (upload?.upload_id ?? null) : null,
      })
      onLaunched(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const ready = !!goal.trim() && !!needBy && budget > 0 && !unsupported && (specMode === 'sample' || !!upload)

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-8 lg:py-8">
      <section className="animate-fade-up">
        <h1 className="max-w-4xl text-[28px] font-semibold leading-tight tracking-tight text-ink-50 lg:text-[32px]">
          A procurement agent that gets equipment ordered — <span className="text-accent-400">on time, within budget, with you in control.</span>
        </h1>
        <ol className="mt-5 grid gap-3 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-2xl bg-white/[0.03] px-4 py-3.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-400/15 text-accent-300">
                <s.icon className="h-[18px] w-[18px]" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-ink-50">
                  <span className="text-ink-400">{i + 1}.</span> {s.title}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-300">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card p-5 lg:p-6" data-testid="composer">
          <label htmlFor="goal" className="text-[15px] font-semibold text-ink-50">
            What should SiteMind get done?
          </label>
          <textarea
            id="goal"
            data-testid="goal-input"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value)
              setHandedOff(false)
            }}
            rows={3}
            className="field mt-3 resize-none text-base leading-relaxed"
            placeholder="e.g. Get the 2 MW DG sets for Project Alpha ordered by 30 April 2027 within budget ₹38 Cr"
          />

          <div className="mt-3 min-h-[64px]" data-testid="goal-parse">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[13px] text-ink-400">{parsing ? 'Reading your goal…' : 'SiteMind read:'}</span>
              {(['package', 'project', 'need_by', 'budget_inr'] as const).map((f) => {
                const val =
                  f === 'package' ? parse?.package : f === 'project' ? parse?.project : f === 'need_by' ? (parse?.need_by ? fullDate(parse.need_by) : null) : parse?.budget_inr ? inr(parse.budget_inr) : null
                const ev = parse?.evidence[f]
                const missing = !!parse && (parse.missing.includes(f) || (f === 'package' && unsupported))
                return (
                  <span
                    key={f}
                    data-testid={`chip-${f}`}
                    data-state={missing ? 'missing' : val ? 'found' : 'empty'}
                    title={ev ? `Read from: “${ev}”` : missing ? 'Not found in the goal' : undefined}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px]',
                      missing ? 'bg-orange-400/15 text-orange-200' : val ? 'bg-emerald-400/10 text-emerald-100' : 'bg-white/[0.05] text-ink-400',
                    )}
                  >
                    {missing ? <AlertTriangle className="h-3.5 w-3.5" /> : val ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : null}
                    <span className="text-ink-400">{FIELD_LABEL[f]}</span>
                    <span className="font-medium">{missing ? (f === 'package' && unsupported ? `${val ?? ''} — not supported` : 'missing') : (val ?? '…')}</span>
                    {ev && ev.toLowerCase() !== String(val ?? '').toLowerCase() && <span className="hidden text-ink-500 xl:inline">· “{ev}”</span>}
                  </span>
                )
              })}
              {parse && <span className="ml-auto"><Confidence value={parse.confidence} /></span>}
            </div>
            {parse && parse.questions.length > 0 && !unsupported && (
              <ul className="mt-2.5 space-y-1" data-testid="goal-questions">
                {parse.questions.map((q) => (
                  <li key={q} className="flex items-start gap-2 text-sm text-orange-100">
                    <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-orange-300" /> {q}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {unsupported ? (
            <div data-testid="handoff" className="mt-5 rounded-xl border border-orange-400/30 bg-orange-400/[0.07] p-5">
              <div className="flex items-start gap-3">
                <UserRound className="mt-0.5 h-5 w-5 shrink-0 text-orange-300" />
                <div>
                  <div className="text-[15px] font-semibold text-ink-50">SiteMind will hand this to a human</div>
                  <p className="mt-1 text-sm leading-relaxed text-ink-200">
                    {parse?.questions[0] ?? 'There is no vendor catalogue for this package yet.'} Rather than guess, the agent routes the request to a procurement lead with everything it could read from your goal.
                  </p>
                  <Button className="mt-4" variant="secondary" icon={handedOff ? CheckCircle2 : ArrowRight} disabled={handedOff} onClick={() => setHandedOff(true)} data-testid="handoff-button">
                    {handedOff ? 'Handed to procurement lead' : 'Hand off to procurement lead'}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <label className="block">
                  <span className="text-[13px] text-ink-400">Package</span>
                  <select
                    data-testid="package-select"
                    value={pkgId}
                    onChange={(e) => {
                      touched.current.pkg = true
                      setPkgId(e.target.value)
                    }}
                    className="field mt-1.5"
                  >
                    {(packages.length ? packages : [{ package_id: 'swgr-480v', title: '480 V switchgear' } as PackageSpec]).map((p) => (
                      <option key={p.package_id} value={p.package_id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[13px] text-ink-400">PO need-by date</span>
                  <input
                    data-testid="need-by-input"
                    type="date"
                    value={needBy}
                    onChange={(e) => {
                      touched.current.needBy = true
                      setNeedBy(e.target.value)
                    }}
                    className="field num mt-1.5"
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] text-ink-400">Budget ceiling (₹, ex-GST)</span>
                  <input
                    data-testid="budget-input"
                    inputMode="numeric"
                    value={budget ? Math.round(budget).toLocaleString('en-IN') : ''}
                    onChange={(e) => {
                      touched.current.budget = true
                      setBudget(Number(e.target.value.replace(/[^\d]/g, '')))
                    }}
                    className="field num mt-1.5"
                  />
                  <span className="mt-1 block truncate text-[13px] text-ink-400">{budget ? `${inr(budget)} · ${inrWords(budget)}` : ''}</span>
                </label>
                <label className="block">
                  <span className="text-[13px] text-ink-400">Scenario</span>
                  <select data-testid="scenario-select" value={scenario} onChange={(e) => setScenario(e.target.value as 'demo' | 'happy')} className="field mt-1.5">
                    <option value="demo">Demo — scripted disruptions</option>
                    <option value="happy">Happy path</option>
                  </select>
                </label>
              </div>

              <div className="mt-5">
                <span className="text-[13px] text-ink-400">Specification</span>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button
                    data-testid="spec-sample"
                    onClick={() => setSpecMode('sample')}
                    className={cx('inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm', specMode === 'sample' ? 'bg-accent-400/15 text-accent-200 ring-1 ring-inset ring-accent-400/40' : 'bg-white/[0.04] text-ink-200 hover:bg-white/[0.07]')}
                  >
                    <FileText className="h-4 w-4" /> Use sample spec{pkg ? ` · ${pkg.spec_document}` : ''}
                  </button>
                  <button
                    data-testid="spec-upload"
                    onClick={() => {
                      setSpecMode('upload')
                      fileRef.current?.click()
                    }}
                    className={cx('inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm', specMode === 'upload' ? 'bg-accent-400/15 text-accent-200 ring-1 ring-inset ring-accent-400/40' : 'bg-white/[0.04] text-ink-200 hover:bg-white/[0.07]')}
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {upload ? `Uploaded · ${upload.filename}` : 'Upload your own PDF'}
                  </button>
                  <input ref={fileRef} data-testid="spec-file" type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
                </div>
                {specMode === 'upload' && upload?.takeoff && <TakeoffPreview upload={upload} />}
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-4">
                <Button data-testid="launch-button" variant="primary" size="lg" icon={busy ? Loader2 : Rocket} disabled={!ready || busy} onClick={() => void launch()} className={cx(busy && '[&>svg]:animate-spin')}>
                  Launch agent
                </Button>
                <span className="text-sm text-ink-400">{pkg ? `${pkg.title} · required on site ${fullDate(pkg.required_on_site)} · sim starts Mon 11 Jan 2027` : ''}</span>
              </div>
            </>
          )}
          {err && <div className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{err}</div>}
        </section>

        <aside className="space-y-3">
          <div className="text-[15px] font-semibold text-ink-50">Packages SiteMind can buy</div>
          {packages.map((p) => {
            const I = PKG_ICON[p.package_id] ?? FileText
            const active = p.package_id === pkgId && !unsupported
            return (
              <button
                key={p.package_id}
                data-testid={`package-card-${p.package_id}`}
                onClick={() => pickPackage(p)}
                className={cx('card w-full p-4 text-left transition-colors hover:bg-ink-800', active && 'border-accent-400/40 bg-accent-400/[0.04]')}
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.05] text-accent-300">
                    <I className="h-[18px] w-[18px]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-ink-50">{p.title}</div>
                    <div className="text-[13px] text-ink-400">
                      {p.vendor_ids.length} vendors · {inr(p.default_budget_inr)} ceiling
                    </div>
                  </div>
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-ink-300">{p.description}</p>
              </button>
            )
          })}
          <p className="px-1 text-[13px] leading-relaxed text-ink-500">Anything else (chillers, transformers…) is handed to a human instead of guessed.</p>
        </aside>
      </div>

      {runs.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink-50">
            <History className="h-4 w-4 text-ink-400" /> Recent runs
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {runs
              .slice(-6)
              .reverse()
              .map((r) => {
                const st = RUN_STATUS[r.status]
                return (
                  <button key={r.run_id} onClick={() => onOpen(r.run_id)} className="card group flex items-center gap-3 p-4 text-left transition-colors hover:bg-ink-800">
                    <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', TONE[st.tone].dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink-100">{r.goal.package} · {r.goal.project}</div>
                      <div className="mt-0.5 truncate text-[13px] text-ink-400">
                        {st.label} · {simClock(r.sim_now)}
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

function TakeoffPreview({ upload }: { upload: SpecUpload }) {
  const t = upload.takeoff!
  return (
    <div data-testid="takeoff-preview" className="mt-3 overflow-hidden rounded-xl border border-white/[0.06]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-white/[0.03] px-4 py-2.5 text-[13px]">
        <span className="font-medium text-ink-100">{upload.filename}</span>
        <span className="text-ink-400">
          {upload.pages} pages · {t.lines.length} lines found
        </span>
        <span className="ml-auto inline-flex items-center gap-2 text-ink-400">
          Confidence <Confidence value={t.confidence} />
        </span>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-ink-900">
            <tr>
              <th className="th">Item</th>
              <th className="th text-right">Qty</th>
              <th className="th">Rating</th>
              <th className="th">Cited from</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.item_code} className="border-t border-white/[0.05]">
                <td className="px-4 py-2">
                  <div className="text-ink-100">{l.description}</div>
                  <div className="font-mono text-[12px] text-ink-400">{l.item_code}</div>
                </td>
                <td className="num px-4 py-2 text-right text-ink-100">
                  {l.qty} {l.unit}
                </td>
                <td className="px-4 py-2 text-ink-300">{l.rating || '—'}</td>
                <td className="px-4 py-2 text-ink-300">{l.source.replace(upload.filename, '').trim() || l.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 border-t border-white/[0.05] px-4 py-2 text-[13px] text-orange-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-400" /> {w}
        </div>
      ))}
    </div>
  )
}
