import { useCallback, useEffect, useRef, useState } from 'react'
import { api, IS_MOCK } from './api'
import { mockApi, type FixtureStage } from './mock/server'
import type { ApprovalDecision, Health, InjectEventRequest, PlanTask, RunSnapshot, TimelineEvent } from './types'
import { useRun } from './lib/useRun'
import { derive } from './lib/derive'
import { Header } from './components/Header'
import { TabsBar, type Toast } from './components/TabsBar'
import { TAB_IDS, type TabId } from './lib/tabs'
import { NowBar } from './components/NowBar'
import { Kpis } from './components/Kpis'
import { TaskGraph } from './components/TaskGraph'
import { Timeline } from './components/Timeline'
import { VendorTable } from './components/Vendors'
import { Budget } from './components/Budget'
import { EventConsole } from './components/EventConsole'
import { PlanTab } from './components/PlanTab'
import { Approvals } from './components/Approvals'
import { Audit } from './components/Audit'
import { PoPackage } from './components/PoPackage'
import { Composer } from './components/Composer'
import { MomentDetail, TaskDetail } from './components/Details'
import { Drawer } from './components/ui'
import { LANE_LABEL } from './lib/status'

function readUrl(): { run: string | null; tab: TabId } {
  const p = new URLSearchParams(window.location.search)
  let run = p.get('run')
  const fixture = p.get('fixture') as FixtureStage | null
  if (IS_MOCK && fixture && !run) run = mockApi.loadFixture(fixture, p.has('live'))
  const t = p.get('tab') as TabId | null
  return { run, tab: t && TAB_IDS.includes(t) ? t : 'overview' }
}

function writeUrl(run: string | null, tab: TabId) {
  const p = new URLSearchParams(window.location.search)
  p.delete('fixture')
  if (run && !IS_MOCK) p.set('run', run)
  else p.delete('run')
  if (tab !== 'overview') p.set('tab', tab)
  else p.delete('tab')
  const qs = p.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
}

const initial = readUrl()

type DrawerState = { kind: 'task'; id: string } | { kind: 'moment'; lane: string; day: string; events: TimelineEvent[] } | null

export default function App() {
  const [runId, setRunId] = useState<string | null>(initial.run)
  const [tab, setTab] = useState<TabId>(initial.tab)
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const { snap, setSnap } = useRun(runId)

  useEffect(() => writeUrl(runId, tab), [runId, tab])
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  const toastTimer = useRef<number | undefined>(undefined)
  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    setToast({ ...t, id: Date.now() })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }, [])

  // Toast only transitions observed live; the first snapshot after (re)loading a run is a baseline.
  const prev = useRef<RunSnapshot | null>(null)
  useEffect(() => {
    const p = prev.current
    if (snap && p && p.run_id === snap.run_id) {
      if (snap.worker.restarts > p.worker.restarts) notify({ tone: 'success', title: `Resumed from checkpoint #${snap.checkpoints}`, body: `worker pid ${snap.worker.pid ?? '—'} · no side effect repeated` })
      if (snap.status === 'completed' && p.status !== 'completed') notify({ tone: 'success', title: 'Goal achieved', body: snap.po ? `${snap.po.po_number} sent to ${snap.po.vendor_name}` : undefined })
      const fresh = snap.approvals.filter((a) => a.status === 'pending' && !p.approvals.some((x) => x.id === a.id))
      if (fresh[0]) notify({ tone: 'info', title: 'Approval needed', body: fresh[0].title })
      const applied = (snap.events ?? []).filter((e) => e.status === 'applied' && p.events?.find((x) => x.id === e.id)?.status === 'pending')
      if (applied[0]) notify({ tone: 'info', title: `Agent reacted to ${applied[0].id}`, body: applied[0].outcome ?? undefined })
    }
    prev.current = snap
  }, [snap, notify])

  const act = async (fn: () => Promise<RunSnapshot>, after?: (s: RunSnapshot) => void) => {
    setBusy(true)
    try {
      const s = await fn()
      setSnap(s)
      after?.(s)
    } catch (e) {
      notify({ tone: 'danger', title: 'Request failed', body: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      setBusy(false)
    }
  }

  const onKill = () => {
    if (runId) void act(() => api.kill(runId), (s) => notify({ tone: 'danger', title: 'Worker killed (SIGKILL)', body: `state is durable at checkpoint #${s.checkpoints}` })).catch(() => undefined)
  }
  const onResume = () => {
    if (runId) void act(() => api.resume(runId)).catch(() => undefined)
  }
  const onDecide = async (approvalId: string, d: ApprovalDecision) => {
    if (runId) await act(() => api.decide(runId, approvalId, d)).catch(() => undefined)
  }
  const onInject = async (req: InjectEventRequest) => {
    if (runId) await act(() => api.injectEvent(runId, req), () => notify({ tone: 'info', title: 'Event injected', body: `${req.type.replace(/_/g, ' ')}${req.vendor_id ? ` on ${req.vendor_id}` : ''} — waiting for the agent` }))
  }
  const goHome = () => {
    setRunId(null)
    setTab('overview')
    setDrawer(null)
  }
  const openTask = (t: PlanTask) => setDrawer({ kind: 'task', id: t.id })
  const openMoment = (lane: string, day: string, events: TimelineEvent[]) => setDrawer({ kind: 'moment', lane, day, events })

  const d = snap ? derive(snap) : null
  const llm = snap?.llm.provider ? `LLM ${String(snap.llm.provider)} · ${String(snap.llm.model ?? '')}` : health ? `LLM ${health.llm.provider} · ${health.llm.model}` : ''
  const drawerTask = drawer?.kind === 'task' ? snap?.plan?.tasks.find((t) => t.id === drawer.id) : null

  return (
    <div className="flex min-h-screen flex-col">
      <Header snap={runId ? snap : null} busy={busy} onKill={onKill} onResume={onResume} onHome={goHome} />
      {!runId ? (
        <main className="flex-1">
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
        <>
          <TabsBar
            tab={tab}
            onTab={setTab}
            toast={toast}
            onDismiss={() => setToast(null)}
            llm={llm}
            counts={{
              plan: { n: d?.total ?? 0 },
              vendors: { n: snap?.quotes.length ?? 0 },
              approvals: { n: d?.pending.length ?? 0, urgent: (d?.pending.length ?? 0) > 0 },
              audit: { n: snap?.audit.length ?? 0 },
            }}
          />
          <main className="flex-1 px-4 py-5 lg:px-6">
            <div className="mx-auto w-full max-w-[1720px] space-y-4">
              {!snap || !d ? (
                <div className="grid h-64 place-items-center text-sm text-ink-400">Loading run…</div>
              ) : (
                <>
                  <NowBar snap={snap} d={d} onGo={setTab} onResume={onResume} busy={busy} tab={tab} />
                  {tab === 'overview' && (
                    <>
                      <Kpis snap={snap} d={d} />
                      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
                        <TaskGraph snap={snap} onSelect={openTask} compact />
                        <Budget snap={snap} />
                      </div>
                      <VendorTable snap={snap} />
                      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
                        <Timeline snap={snap} onOpen={openMoment} />
                        <EventConsole snap={snap} onInject={onInject} busy={busy} />
                      </div>
                    </>
                  )}
                  {tab === 'plan' && <PlanTab snap={snap} onSelect={openTask} />}
                  {tab === 'vendors' && (
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
                      <VendorTable snap={snap} full />
                      <div className="space-y-4">
                        <Budget snap={snap} />
                        <EventConsole snap={snap} onInject={onInject} busy={busy} />
                      </div>
                    </div>
                  )}
                  {tab === 'approvals' && <Approvals snap={snap} onDecide={onDecide} busy={busy} />}
                  {tab === 'audit' && <Audit snap={snap} />}
                  {tab === 'po' && <PoPackage snap={snap} />}
                </>
              )}
            </div>
          </main>
        </>
      )}
      {snap && (
        <Drawer
          testId="detail-drawer"
          open={!!drawer && (drawer.kind === 'moment' || !!drawerTask)}
          onClose={() => setDrawer(null)}
          title={drawer?.kind === 'task' ? (drawerTask?.title ?? '') : drawer?.kind === 'moment' ? `${LANE_LABEL[drawer.lane] ?? drawer.lane} · ${drawer.day}` : ''}
          subtitle={drawer?.kind === 'task' ? drawerTask?.id : 'Timeline moment'}
        >
          {drawer?.kind === 'task' && drawerTask && <TaskDetail snap={snap} task={drawerTask} />}
          {drawer?.kind === 'moment' && <MomentDetail snap={snap} lane={drawer.lane} day={drawer.day} events={drawer.events} />}
        </Drawer>
      )}
    </div>
  )
}
