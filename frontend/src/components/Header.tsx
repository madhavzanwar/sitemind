import { Clock3, Play, Skull } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { cx, simClock, simDay } from '../lib/format'
import { IS_MOCK } from '../api'
import { Button } from './ui'
import { Logo } from './Logo'

export function Header({
  snap,
  busy,
  onKill,
  onResume,
  onHome,
}: {
  snap: RunSnapshot | null
  busy: boolean
  onKill: () => void
  onResume: () => void
  onHome: () => void
}) {
  const killed = snap?.status === 'killed'
  const finished = snap?.status === 'completed' || snap?.status === 'failed'
  const w = snap?.worker
  const parked = !!w && !w.alive && snap?.status === 'waiting_human'
  const ok = !!w && (w.alive || parked || finished)
  const workerLabel = !w ? '' : w.alive ? 'Worker running' : parked ? 'Worker parked' : finished ? 'Worker finished' : 'Worker offline'
  const workerDot = !w ? '' : w.alive ? 'bg-emerald-400' : parked ? 'bg-violet-400' : ok ? 'bg-ink-300' : 'bg-rose-500'

  return (
    <header
      className={cx(
        'relative z-20 flex h-16 shrink-0 items-center gap-4 border-b px-4 transition-colors duration-500 lg:px-6',
        killed ? 'border-rose-500/30 bg-rose-950/40' : 'border-white/[0.06] bg-ink-950',
      )}
    >
      <button onClick={onHome} className="flex shrink-0 items-center gap-2.5 rounded-lg pr-1" aria-label="SiteMind home">
        <Logo size={32} />
        <span className="text-[17px] font-semibold tracking-tight text-ink-50">
          Site<span className="text-accent-400">Mind</span>
        </span>
        {IS_MOCK && <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-ink-300">demo data</span>}
      </button>

      {snap && (
        <>
          <div className="hidden h-7 w-px bg-white/[0.08] md:block" />
          <div className="hidden min-w-0 leading-tight md:block" data-testid="run-package">
            <div className="truncate text-sm font-semibold text-ink-50">{snap.goal.package}</div>
            <div className="truncate text-[13px] text-ink-400">{snap.goal.project} · Chakan MIDC, Pune</div>
          </div>

          <div data-testid="sim-clock" className="ml-auto flex shrink-0 items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 lg:ml-4" title="Simulated project time — the agent's clock">
            <Clock3 className={cx('h-4 w-4', killed ? 'text-rose-400' : 'text-accent-400')} strokeWidth={2} />
            <span className="hidden text-[13px] text-ink-400 xl:inline">Sim time</span>
            <span className="num text-[13px] text-ink-50">{simClock(snap.sim_now)}</span>
            <span className="text-ink-500">·</span>
            <span className="num text-[13px] font-semibold text-accent-300">Day {simDay(snap.sim_now, snap.sim_start)}</span>
          </div>
        </>
      )}

      {w && snap && (
        <div className={cx('flex shrink-0 items-center gap-3', !snap && 'ml-auto', 'lg:ml-auto')}>
          <div
            data-testid="worker-status"
            data-alive={w.alive ? 'true' : 'false'}
            title={`pid ${w.pid ?? '—'} · ${w.restarts} restart(s) · ${snap.checkpoints} checkpoints${parked ? ' — worker exits cleanly at an approval and is respawned when you decide' : ''}`}
            className={cx('flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]', killed ? 'bg-rose-500/15' : 'bg-white/[0.04]')}
          >
            <span className="relative flex h-2 w-2">
              {w.alive && !finished && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={cx('relative inline-flex h-2 w-2 rounded-full', workerDot)} />
            </span>
            <span className={cx('font-medium', killed ? 'text-rose-200' : 'text-ink-100')}>{workerLabel}</span>
            <span className="num hidden text-ink-400 2xl:inline">
              pid {w.pid ?? '—'} · {w.restarts} restart{w.restarts === 1 ? '' : 's'} · {snap.checkpoints} checkpoints
            </span>
          </div>
          <Button data-testid="resume-button" variant={killed ? 'success' : 'ghost'} icon={Play} disabled={!killed || busy} onClick={onResume}>
            Resume
          </Button>
          <Button data-testid="kill-button" variant="danger" icon={Skull} disabled={killed || finished || busy} onClick={onKill} title="Send SIGKILL to the worker process">
            <span className="hidden sm:inline">Kill worker</span>
          </Button>
        </div>
      )}
    </header>
  )
}
