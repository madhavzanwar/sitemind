import { Clock3, Cpu, Database, Play, Skull, Zap } from 'lucide-react'
import type { Health, RunSnapshot } from '../types'
import { cx, simClock, simDay } from '../lib/format'
import { Button } from './ui'
import { Logo } from './Logo'
import { IS_MOCK } from '../api'

export function Header({
  snap,
  health,
  busy,
  onKill,
  onResume,
  onHome,
}: {
  snap: RunSnapshot | null
  health: Health | null
  busy: boolean
  onKill: () => void
  onResume: () => void
  onHome: () => void
}) {
  const killed = snap?.status === 'killed'
  const finished = snap?.status === 'completed' || snap?.status === 'failed'
  const provider = (snap?.llm.provider as string | undefined) ?? health?.llm.provider ?? 'llm'
  const model = (snap?.llm.model as string | undefined) ?? health?.llm.model ?? '—'
  const calls = snap?.llm.calls
  const reachable = health?.llm.reachable ?? true
  const w = snap?.worker

  return (
    <header
      className={cx(
        'relative z-20 flex h-16 shrink-0 items-center gap-5 border-b px-5 backdrop-blur-xl transition-colors duration-500',
        killed ? 'border-rose-500/30 bg-rose-950/30' : 'border-white/[0.06] bg-ink-950/70',
      )}
    >
      <button onClick={onHome} className="flex items-center gap-3 rounded-lg pr-2 transition hover:opacity-90" aria-label="SiteMind home">
        <Logo />
        <div className="leading-none">
          <div className="text-[17px] font-semibold tracking-tight text-ink-50">
            Site<span className="text-accent-400">Mind</span>
          </div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-400">
            Procurement agent{IS_MOCK && <span className="ml-1.5 rounded bg-white/[0.06] px-1 text-ink-300">mock</span>}
          </div>
        </div>
      </button>

      {snap && (
        <>
          <div className="h-8 w-px bg-white/[0.07]" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-ink-100">{snap.goal.project}</div>
            <div className="truncate text-[11.5px] text-ink-400">
              {snap.goal.package} · 24 MW Tier-III DC · Chakan MIDC, Pune
            </div>
          </div>

          <div
            data-testid="sim-clock"
            className="ml-2 flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-1.5 ring-1 ring-inset ring-white/[0.07]"
          >
            <Clock3 className={cx('h-4 w-4', killed ? 'text-rose-400' : 'text-accent-400')} strokeWidth={2} />
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-400">Sim time</span>
            <span className="num text-[13px] font-medium text-ink-50">{simClock(snap.sim_now)}</span>
            <span className="text-ink-500">·</span>
            <span className="num text-[13px] font-semibold text-accent-300">Day {simDay(snap.sim_now, snap.sim_start)}</span>
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        <div
          data-testid="llm-badge"
          className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12px] ring-1 ring-inset ring-white/[0.07]"
          title={reachable ? 'LLM reachable' : 'LLM unreachable — deterministic fallback'}
        >
          <Cpu className="h-3.5 w-3.5 text-sky-300" strokeWidth={2} />
          <span className="font-medium text-ink-200">{provider}</span>
          <span className="num text-ink-400">{model}</span>
          {calls != null && <span className="num rounded bg-white/[0.05] px-1.5 text-[11px] text-ink-300">{calls} calls</span>}
          <span className={cx('h-1.5 w-1.5 rounded-full', reachable ? 'bg-emerald-400' : 'bg-orange-400')} />
        </div>

        {w && snap && (
          <div
            data-testid="worker-status"
            data-alive={w.alive ? 'true' : 'false'}
            className={cx(
              'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12px] ring-1 ring-inset transition-colors',
              w.alive ? 'bg-emerald-400/[0.06] ring-emerald-400/20' : 'bg-rose-500/10 ring-rose-500/40',
            )}
          >
            <span className="relative flex h-2 w-2">
              {w.alive && !finished && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={cx('relative inline-flex h-2 w-2 rounded-full', w.alive ? 'bg-emerald-400' : 'bg-rose-500')} />
            </span>
            <span className={cx('font-semibold', w.alive ? 'text-emerald-300' : 'text-rose-300')}>
              {w.alive ? 'Worker alive' : finished ? 'Worker exited' : 'Worker offline'}
            </span>
            <span className="num text-ink-400">pid {w.pid ?? '—'}</span>
            <span className="h-3 w-px bg-white/10" />
            <span className="num flex items-center gap-1 text-ink-300" title="Worker restarts">
              <Zap className="h-3 w-3" /> {w.restarts}
            </span>
            <span className="num flex items-center gap-1 text-ink-300" title="LangGraph checkpoints persisted">
              <Database className="h-3 w-3" /> {snap.checkpoints}
            </span>
          </div>
        )}

        {snap && (
          <>
            <Button
              data-testid="resume-button"
              variant={killed ? 'success' : 'secondary'}
              icon={Play}
              disabled={!killed || busy}
              onClick={onResume}
              className={cx(killed && 'animate-pulse-ring')}
            >
              Resume
            </Button>
            <Button data-testid="kill-button" variant="danger" icon={Skull} disabled={killed || finished || busy} onClick={onKill}>
              Kill worker <span className="font-mono text-[11px] font-medium opacity-80">SIGKILL</span>
            </Button>
          </>
        )}
      </div>
    </header>
  )
}
