import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, ShieldAlert } from 'lucide-react'
import { api, IS_MOCK } from './api'
import { mockApi, type FixtureStage } from './mock/server'
import type { ApprovalDecision, Health, RunSnapshot } from './types'
import { useRun } from './lib/useRun'
import { Header } from './components/Header'
import { NavRail, type TabId } from './components/NavRail'
import { Hero } from './components/Hero'
import { TaskGraph } from './components/TaskGraph'
import { Timeline } from './components/Timeline'
import { Vendors } from './components/Vendors'
import { Budget } from './components/Budget'
import { Approvals } from './components/Approvals'
import { Audit } from './components/Audit'
import { PoPackage } from './components/PoPackage'
import { Composer } from './components/Composer'
import { Toasts, type Toast } from './components/Toasts'
import { Button } from './components/ui'

const TAB_IDS: TabId[] = ['overview', 'approvals', 'audit', 'po']

function readUrl(): { run: string | null; tab: TabId } {
  const p = new URLSearchParams(window.location.search)
  let run = p.get('run')
  const fixture = p.get('fixture') as FixtureStage | null
  if (IS_MOCK && fixture && !run) {
    run = mockApi.loadFixture(fixture, p.has('live'))
  }
  const t = p.get('tab') as TabId | null
  return { run, tab: t && TAB_IDS.includes(t) ? t : 'overview' }
}

function writeUrl(run: string | null, tab: TabId) {
  const p = new URLSearchParams(window.location.search)
  p.delete('fixture')
  if (run) p.set('run', run)
  else p.delete('run')
  if (tab !== 'overview') p.set('tab', tab)
  else p.delete('tab')
  // mock runs live only in memory; don't keep their ids across reloads
  if (IS_MOCK) p.delete('run')
  const qs = p.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
}

const initial = readUrl()

export default function App() {
  const [runId, setRunId] = useState<string | null>(initial.run)
  const [tab, setTab] = useState<TabId>(initial.tab)
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const { snap, setSnap } = useRun(runId)

  useEffect(() => writeUrl(runId, tab), [runId, tab])
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setToasts((ts) => [...ts, { ...t, id }])
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6500)
  }, [])

  // "resumed from checkpoint #N" toast when the worker restart count goes up
  const prev = useRef<RunSnapshot | null>(null)
  useEffect(() => {
    const p = prev.current
    if (snap && p && p.run_id === snap.run_id) {
      if (snap.worker.restarts > p.worker.restarts) {
        toast({
          tone: 'success',
          title: `Resumed from checkpoint #${snap.checkpoints}`,
          body: `New worker pid ${snap.worker.pid ?? '—'} picked up the LangGraph thread. Completed side effects are replayed from the ledger, not re-executed.`,
        })
      }
      if (snap.status === 'completed' && p.status !== 'completed') {
        toast({ tone: 'success', title: 'Goal achieved', body: snap.po ? `${snap.po.po_number} sent to ${snap.po.vendor_name}.` : 'Run completed.' })
      }
      const newPending = snap.approvals.filter((a) => a.status === 'pending' && !p.approvals.some((x) => x.id === a.id))
      newPending.forEach((a) => toast({ tone: 'info', title: 'Human approval needed', body: a.title }))
    }
    prev.current = snap
  }, [snap, toast])

  const act = async (fn: () => Promise<RunSnapshot>, after?: (s: RunSnapshot) => void) => {
    setBusy(true)
    try {
      const s = await fn()
      setSnap(s)
      after?.(s)
    } catch (e) {
      toast({ tone: 'danger', title: 'Request failed', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const onKill = () =>
    runId &&
    void act(
      () => api.kill(runId),
      (s) => toast({ tone: 'danger', title: 'Worker killed (SIGKILL)', body: `Process terminated at checkpoint #${s.checkpoints}. State is durable — press Resume.` }),
    )
  const onResume = () => runId && void act(() => api.resume(runId))
  const onDecide = async (approvalId: string, d: ApprovalDecision) => {
    if (!runId) return
    await act(() => api.decide(runId, approvalId, d))
  }

  const goHome = () => {
    setRunId(null)
    setTab('overview')
  }

  const pending = snap?.approvals.filter((a) => a.status === 'pending').length ?? 0
  const killed = snap?.status === 'killed'

  return (
    <div className="flex h-full min-h-screen flex-col">
      <Header snap={runId ? snap : null} health={health} busy={busy} onKill={onKill} onResume={onResume} onHome={goHome} />
      {!runId ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <Composer
            onLaunched={(s) => {
              setSnap(s)
              setRunId(s.run_id)
              setTab('overview')
            }}
            onOpen={(id) => setRunId(id)}
          />
        </main>
      ) : (
        <div className="flex min-h-0 flex-1">
          <NavRail tab={tab} onTab={setTab} pending={pending} poReady={snap?.po?.status === 'sent'} onNew={goHome} />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4">
            {killed && snap && (
              <div
                data-testid="killed-banner"
                className="relative flex animate-fade-up items-center gap-4 overflow-hidden rounded-2xl border border-rose-500/40 bg-gradient-to-r from-rose-950/80 via-rose-900/30 to-ink-900/60 px-5 py-3 shadow-danger"
              >
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div className="absolute inset-y-0 w-1/3 animate-scan bg-gradient-to-r from-transparent via-rose-500/10 to-transparent" />
                </div>
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-500/20 ring-1 ring-inset ring-rose-400/40">
                  <ShieldAlert className="h-5 w-5 text-rose-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-rose-100">Worker offline — SIGKILL delivered to pid {snap.worker.pid ?? '—'}</div>
                  <div className="text-[12.5px] text-rose-200/70">
                    Progress is frozen, not lost: LangGraph state is durable at checkpoint #{snap.checkpoints}, and every completed side effect is in the idempotency ledger.
                  </div>
                </div>
                <Button variant="success" icon={Play} onClick={onResume} disabled={busy}>
                  Resume from checkpoint #{snap.checkpoints}
                </Button>
              </div>
            )}
            {!snap ? (
              <div className="grid flex-1 place-items-center text-sm text-ink-400">Loading run…</div>
            ) : tab === 'overview' ? (
              <Overview snap={snap} />
            ) : tab === 'approvals' ? (
              <div className="min-h-0 flex-1">
                <Approvals snap={snap} onDecide={onDecide} busy={busy} />
              </div>
            ) : tab === 'audit' ? (
              <div className="min-h-0 flex-1">
                <Audit snap={snap} />
              </div>
            ) : (
              <div className="min-h-0 flex-1">
                <PoPackage snap={snap} />
              </div>
            )}
          </main>
        </div>
      )}
      <Toasts toasts={toasts} onClose={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
    </div>
  )
}

function Overview({ snap }: { snap: RunSnapshot }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Hero snap={snap} />
      <TaskGraph snap={snap} className="h-[272px] shrink-0" />
      <div className="grid min-h-[440px] flex-1 grid-cols-12 grid-rows-[minmax(0,1fr)] gap-4">
        <Timeline snap={snap} className="col-span-5" />
        <Vendors snap={snap} className="col-span-4" />
        <Budget snap={snap} className="col-span-3" />
      </div>
    </div>
  )
}
