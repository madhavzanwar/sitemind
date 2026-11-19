import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleSlash, Loader2, Zap } from 'lucide-react'
import type { EventTypeSpec, InjectEventRequest, PackageSpec, RunSnapshot } from '../types'
import { api } from '../api'
import { cx, dateTime } from '../lib/format'
import { Button, Card } from './ui'

export function EventConsole({ snap, onInject, busy, className }: { snap: RunSnapshot; onInject: (req: InjectEventRequest) => Promise<void>; busy: boolean; className?: string }) {
  const [types, setTypes] = useState<EventTypeSpec[]>([])
  const [packages, setPackages] = useState<PackageSpec[]>([])
  const [type, setType] = useState<string>('price_change')
  const [vendor, setVendor] = useState<string>('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.eventTypes().then(setTypes).catch((e: unknown) => setErr(`Event types unavailable: ${e instanceof Error ? e.message : String(e)}`))
    api.packages().then(setPackages).catch(() => undefined)
  }, [])

  const spec = types.find((t) => t.type === type) ?? types[0]
  useEffect(() => {
    if (!spec) return
    setParams(Object.fromEntries(spec.params.map((p) => [p.name, p.default == null ? '' : String(p.default)])))
  }, [spec])

  const vendors = useMemo(() => {
    const ids = new Set<string>()
    snap.quotes.forEach((q) => ids.add(q.vendor_id))
    snap.options.forEach((o) => ids.add(o.vendor_id))
    snap.vendor_attempts.forEach((a) => ids.add(a.vendor_id))
    packages.find((p) => p.package_id === snap.package_id)?.vendor_ids.forEach((v) => ids.add(v))
    return [...ids].sort().map((id) => ({ id, name: snap.quotes.find((q) => q.vendor_id === id)?.vendor_name ?? id }))
  }, [snap.quotes, snap.options, snap.vendor_attempts, snap.package_id, packages])
  const recVendor = snap.options.find((o) => o.recommended)?.vendor_id
  const vSel = vendor || recVendor || vendors[0]?.id || ''

  const submit = async () => {
    if (!spec) return
    const p: Record<string, unknown> = {}
    for (const ps of spec.params) {
      const raw = params[ps.name] ?? ''
      p[ps.name] = ps.kind === 'int' ? parseInt(raw, 10) : ps.kind === 'float' ? parseFloat(raw) : raw
    }
    setErr(null)
    try {
      await onInject({ type: spec.type, vendor_id: spec.needs_vendor || spec.type === 'date_slip' ? vSel || null : null, params: p, note: note || null })
      setNote('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const events = [...(snap.events ?? [])].reverse()
  return (
    <Card testId="event-console" title="Inject a live event" icon={Zap} subtitle="Change the world; watch the agent react" className={className} bodyClassName="px-5 pb-5">
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block sm:col-span-1">
          <span className="text-[13px] text-ink-400">Event</span>
          <select data-testid="event-type" value={spec?.type ?? type} onChange={(e) => setType(e.target.value)} className="field mt-1.5">
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {(spec?.needs_vendor || spec?.type === 'date_slip') && (
          <label className="col-span-2 block sm:col-span-1">
            <span className="text-[13px] text-ink-400">Vendor</span>
            <select data-testid="event-vendor" value={vSel} onChange={(e) => setVendor(e.target.value)} className="field mt-1.5">
              {!spec.needs_vendor && <option value="">None (site date)</option>}
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} · {v.name}
                  {v.id === recVendor ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {spec?.params.map((p) => (
          <label key={p.name} className="block">
            <span className="text-[13px] text-ink-400">
              {p.label}
              {p.unit && ` (${p.unit})`}
            </span>
            {p.kind === 'choice' ? (
              <select data-testid={`event-param-${p.name}`} value={params[p.name] ?? ''} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} className="field mt-1.5">
                {p.choices.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            ) : (
              <input
                data-testid={`event-param-${p.name}`}
                type={p.kind === 'text' ? 'text' : 'number'}
                min={p.min ?? undefined}
                max={p.max ?? undefined}
                step={p.kind === 'float' ? 0.5 : 1}
                value={params[p.name] ?? ''}
                onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                className="field num mt-1.5"
              />
            )}
          </label>
        ))}
        <label className="col-span-2 block">
          <span className="text-[13px] text-ink-400">Note (optional)</span>
          <input data-testid="event-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Vendor called about a steel surcharge" className="field mt-1.5" />
        </label>
      </div>
      {spec && <p className="mt-2.5 text-[13px] leading-relaxed text-ink-400">{spec.description}</p>}
      <Button data-testid="inject-event" variant="primary" icon={Zap} className="mt-3 w-full" disabled={!spec || busy || snap.status === 'completed'} onClick={() => void submit()}>
        Inject event
      </Button>
      {err && <p className="mt-2 text-[13px] text-rose-300">{err}</p>}

      <div data-testid="event-feed" className="mt-5">
        <div className="text-[13px] font-medium text-ink-300">Event feed</div>
        {events.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">No events injected yet.</p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {events.map((ev) => (
              <li key={ev.id} data-testid="event-item" data-status={ev.status} data-type={ev.type} className="rounded-xl bg-white/[0.03] px-3.5 py-3">
                <div className="flex items-center gap-2 text-sm">
                  {ev.status === 'pending' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-accent-300" />
                  ) : ev.status === 'applied' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <CircleSlash className="h-4 w-4 text-ink-400" />
                  )}
                  <span className="font-medium text-ink-50">
                    {types.find((t) => t.type === ev.type)?.title ?? ev.type.replace(/_/g, ' ')}
                    {ev.vendor_id && ` · ${ev.vendor_id}`}
                  </span>
                  <span className="text-[13px] text-ink-400">{Object.entries(ev.params).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</span>
                  <span className={cx('ml-auto text-xs font-medium', ev.status === 'pending' ? 'text-accent-300' : ev.status === 'applied' ? 'text-emerald-300' : 'text-ink-400')}>{ev.status}</span>
                </div>
                {ev.outcome ? (
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-200">{ev.outcome}</p>
                ) : (
                  <p className="mt-1.5 text-[13px] text-ink-400">Waiting for the worker to pick it up…</p>
                )}
                <div className="mt-1 text-xs text-ink-500">
                  {ev.id}
                  {ev.applied_sim_time && ` · applied ${dateTime(ev.applied_sim_time)}`}
                  {ev.note && ` · “${ev.note}”`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
