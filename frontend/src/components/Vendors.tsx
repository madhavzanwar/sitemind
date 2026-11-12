import { useRef } from 'react'
import { Award, Building2, Clock, RefreshCw, TimerOff, TrendingUp, Truck, ShieldCheck, Ban, CheckCircle2, Rocket } from 'lucide-react'
import type { Quote, RunSnapshot, VendorAttempt, VendorOption } from '../types'
import { cx, dayMonth, inr, pct, signed } from '../lib/format'
import { VERDICT_TONE } from '../lib/status'
import { Badge, Card, Empty } from './ui'

interface Row {
  id: string
  name: string
  quote?: Quote
  option?: VendorOption
  attempts: VendorAttempt[]
}

function vendorRows(snap: RunSnapshot, selected: string | null | undefined): Row[] {
  const ids = new Set<string>()
  snap.quotes.forEach((q) => ids.add(q.vendor_id))
  snap.options.forEach((o) => ids.add(o.vendor_id))
  snap.vendor_attempts.forEach((a) => ids.add(a.vendor_id))
  return [...ids].sort().map((id) => {
    const quote = snap.quotes.find((q) => q.vendor_id === id)
    const mine = snap.options.filter((o) => o.vendor_id === id)
    const option = mine.find((o) => o.option_id === selected) ?? mine.find((o) => o.recommended) ?? mine[0]
    return {
      id,
      name: quote?.vendor_name ?? option?.vendor_name ?? id,
      quote,
      option,
      attempts: snap.vendor_attempts.filter((a) => a.vendor_id === id).sort((a, b) => a.attempt - b.attempt),
    }
  })
}

export function Vendors({ snap, className }: { snap: RunSnapshot; className?: string }) {
  const selected = snap.approvals.find((a) => a.kind === 'vendor_selection' && a.status === 'approved')?.decided_option
  const rows = vendorRows(snap, selected)
  // Remember the first-seen revision-1 total per vendor to show revision deltas.
  const firstTotals = useRef<Record<string, number>>({})
  snap.quotes.forEach((q) => {
    if (q.revision === 1 && firstTotals.current[q.vendor_id] == null) firstTotals.current[q.vendor_id] = q.total_inr
  })
  return (
    <Card
      testId="vendor-table"
      title="Vendor comparison"
      icon={Building2}
      subtitle={rows.length ? `${snap.quotes.length}/${rows.length} quotes in` : undefined}
      className={className}
      bodyClassName="overflow-auto p-3"
    >
      {rows.length === 0 ? (
        <Empty icon={Building2} title="No RFQs yet" hint="Quotes appear once the takeoff is complete and RFQs are dispatched." />
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <VendorCard key={r.id} row={r} firstTotal={firstTotals.current[r.id]} chosen={!!selected && selected === r.option?.option_id} />
          ))}
        </div>
      )}
    </Card>
  )
}

function VendorCard({ row, firstTotal, chosen }: { row: Row; firstTotal?: number; chosen: boolean }) {
  const { quote: q, option: o } = row
  const total = o?.total_inr ?? q?.total_inr
  const revised = (q?.revision ?? 1) > 1
  const revAttempt = row.attempts.find((a) => a.outcome === 'revised')
  const parsedOld = revAttempt?.detail.match(/INR\s*([\d,]+)\s*(?:->|→)/)?.[1]
  const oldTotal = firstTotal ?? (parsedOld ? Number(parsedOld.replace(/,/g, '')) : undefined)
  const delta = revised && q && oldTotal ? q.total_inr - oldTotal : null
  const deltaPct = delta != null && oldTotal ? delta / oldTotal : null
  const revPct = revAttempt?.detail.match(/\(([+−-][\d.]+\s?%)\)/)?.[1]
  const waiting = !q
  const rec = o?.recommended
  const verdict = o?.budget_verdict
  return (
    <div
      data-testid={`vendor-${row.id}`}
      className={cx(
        'relative rounded-xl border px-3.5 py-2.5 transition-all duration-500',
        rec || chosen ? 'border-accent-400/40 bg-accent-400/[0.04] shadow-glow' : 'border-white/[0.06] bg-ink-850/70',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.05] font-mono text-[11px] font-bold text-ink-100 ring-1 ring-inset ring-white/10">
          {row.id}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cx('truncate text-[13px] font-semibold', waiting && row.name === row.id ? 'italic text-ink-400' : 'text-ink-50')}>
            {waiting && row.name === row.id ? 'Awaiting quote…' : row.name}
          </div>
          <div className="truncate font-mono text-[10.5px] text-ink-400">
            {q ? `${q.quote_id} · rev ${q.revision}` : `RFQ attempts: ${row.attempts.length}`}
          </div>
        </div>
        {chosen ? (
          <Badge tone="accent" className="font-semibold">
            <CheckCircle2 className="h-3 w-3" /> Selected
          </Badge>
        ) : (
          rec && (
            <Badge tone="accent" className="font-semibold">
              <Award className="h-3 w-3" /> Recommended
            </Badge>
          )
        )}
        <div className="text-right">
          <div className={cx('num text-[17px] font-semibold leading-none', waiting ? 'text-ink-500' : 'text-ink-50')}>{total != null ? inr(total) : '—'}</div>
          {revised && (
            <div className="mt-1 flex justify-end">
              {oldTotal != null && <span className="num mr-1.5 self-center text-[10.5px] text-ink-500 line-through">{inr(oldTotal)}</span>}
              <Badge tone="danger" testId={`revised-${row.id}`} title={revAttempt?.detail}>
                <TrendingUp className="h-3 w-3" />
                Rev {q?.revision}
                {deltaPct != null ? ` +${(deltaPct * 100).toFixed(1)} %` : revPct ? ` ${revPct}` : ''}
              </Badge>
            </div>
          )}
        </div>
      </div>

      {(q || o) && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          <Metric icon={Clock} label="Lead" value={`${o?.lead_time_days ?? q?.lead_time_days ?? '—'} d`} />
          <Metric icon={Truck} label="Delivery" value={o ? dayMonth(o.delivery_date) : '—'} />
          <Metric
            icon={o && o.float_days < 0 ? Ban : ShieldCheck}
            label="Float"
            value={o ? signed(o.float_days) : '—'}
            tone={o ? (o.float_days < 0 ? 'text-rose-300' : o.float_days < 14 ? 'text-orange-300' : 'text-emerald-300') : undefined}
          />
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-400">Reliability</div>
            <div className="num mt-0.5 text-[12.5px] font-medium text-ink-100">{pct(q?.reliability ?? o?.reliability ?? 0)}</div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-sky-400/80" style={{ width: `${(q?.reliability ?? o?.reliability ?? 0) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {verdict && (
          <Badge tone={VERDICT_TONE[verdict]} dot testId={`verdict-${row.id}`}>
            Budget {verdict}
          </Badge>
        )}
        {o && !o.meets_deadline && <Badge tone="danger">Misses deadline</Badge>}
        {o && o.expedite_fee_inr > 0 && (
          <Badge tone="info">
            <Rocket className="h-3 w-3" /> Expedite {inr(o.expedite_fee_inr)}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1">
          {row.attempts.map((a, i) => (
            <span
              key={i}
              title={`${a.outcome} · ${a.detail}`}
              className={cx(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset',
                a.outcome === 'ok' && 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20',
                a.outcome === 'timeout' && 'bg-orange-400/10 text-orange-300 ring-orange-400/25',
                a.outcome === 'revised' && 'bg-rose-500/10 text-rose-300 ring-rose-400/25',
                a.outcome === 'declined' && 'bg-white/[0.04] text-ink-300 ring-white/10',
              )}
            >
              {a.outcome === 'timeout' ? <TimerOff className="h-2.5 w-2.5" /> : a.outcome === 'revised' ? <RefreshCw className="h-2.5 w-2.5" /> : null}#{a.attempt}{' '}
              {a.outcome}
            </span>
          ))}
          {o && <span className="num ml-1 text-[10.5px] text-ink-400">score {o.score.toFixed(2)}</span>}
        </span>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Clock; label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-400">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={cx('num mt-0.5 text-[12.5px] font-medium', tone ?? 'text-ink-100')}>{value}</div>
    </div>
  )
}
