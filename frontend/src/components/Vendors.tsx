import { useRef } from 'react'
import { Award, Building2, CheckCircle2, Clock, TrendingDown, TrendingUp } from 'lucide-react'
import type { Quote, RunSnapshot, VendorAttempt, VendorOption } from '../types'
import { committedOf } from '../lib/derive'
import { cx, dayMonth, inr, inrFull, pct, signed } from '../lib/format'
import { VERDICT_TONE, TONE } from '../lib/status'
import { Card, Confidence, Empty } from './ui'

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

function blockedDocs(snap: RunSnapshot): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of snap.events ?? []) if (e.status === 'applied' && e.type === 'document_missing' && e.vendor_id) out[e.vendor_id] = String(e.params.document ?? 'document')
  return out
}

export function VendorTable({ snap, className, full }: { snap: RunSnapshot; className?: string; full?: boolean }) {
  const selected = [...snap.approvals].reverse().find((a) => a.kind === 'vendor_selection' && a.status === 'approved')?.decided_option
  const rows = vendorRows(snap, selected)
  const firstTotals = useRef<Record<string, number>>({})
  snap.quotes.forEach((q) => {
    if (q.revision === 1 && firstTotals.current[q.vendor_id] == null) firstTotals.current[q.vendor_id] = q.total_inr
  })
  const blocked = blockedDocs(snap)
  const rec = snap.options.find((o) => o.recommended)
  const chosen = selected ? snap.options.find((o) => o.option_id === selected) : null
  const focus = chosen ?? rec
  const memo = [...snap.approvals].reverse().find((a) => a.memo)?.memo

  return (
    <Card testId="vendor-table" title="Vendors" icon={Building2} subtitle={rows.length ? `${snap.quotes.length} of ${rows.length} quotes in · ex-GST` : undefined} className={className}>
      {rows.length === 0 ? (
        <Empty icon={Building2} title="No quotes yet" hint="Quotes appear after the spec takeoff, once RFQs go out to the vendors." />
      ) : (
        <>
          <div className="overflow-x-auto px-2">
            <table className="w-full min-w-[880px] text-sm [&_td]:whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="th">Vendor</th>
                  <th className="th text-right">Total</th>
                  <th className="th text-right">Lead time</th>
                  <th className="th text-right">Delivery</th>
                  <th className="th text-right">Float</th>
                  <th className="th text-right">On-time</th>
                  <th className="th">Budget</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const o = r.option
                  const q = r.quote
                  const isSel = !!selected && selected === o?.option_id
                  const isRec = !selected && !!o?.recommended
                  const revAttempt = r.attempts.find((a) => a.outcome === 'revised')
                  const parsedOld = revAttempt?.detail.match(/INR\s*([\d,]+)\s*(?:->|→)/)?.[1]
                  const oldTotal = firstTotals.current[r.id] ?? (parsedOld ? Number(parsedOld.replace(/,/g, '')) : undefined)
                  const revised = (q?.revision ?? 1) > 1 && oldTotal != null && q
                  const delta = revised ? q.total_inr / oldTotal - 1 : 0
                  const timeouts = r.attempts.filter((a) => a.outcome === 'timeout').length
                  const why = !o
                    ? null
                    : blocked[r.id]
                      ? `Blocked: ${blocked[r.id]} missing`
                      : o.budget_verdict === 'breach'
                        ? 'Infeasible: over budget'
                        : !o.meets_deadline
                          ? `Infeasible: ${-o.float_days} d late`
                          : null
                  return (
                    <tr
                      key={r.id}
                      data-testid={`vendor-${r.id}`}
                      className={cx('border-b border-white/[0.04] last:border-0', (isRec || isSel) && 'bg-accent-400/[0.06]')}
                    >
                      <td className={cx('td relative !whitespace-normal', (isRec || isSel) && 'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent-400')}>
                        <div className="font-medium text-ink-50">{q || o ? r.name : <span className="italic text-ink-400">Awaiting quote</span>}</div>
                        <div className="mt-0.5 text-[13px] text-ink-400">
                          <span className="font-mono text-[12px]">{r.id}</span>
                          {q && <span className="font-mono text-[12px]"> · {q.quote_id}</span>}
                          {o && o.expedite_fee_inr > 0 && <span className="text-sky-300"> · with expedite</span>}
                        </div>
                      </td>
                      <td className="td text-right">
                        <div className="num font-medium text-ink-50">{o || q ? inr(o?.total_inr ?? q?.total_inr) : '—'}</div>
                        {revised && Math.abs(delta) < 0.0005 && (
                          <div data-testid={`revised-${r.id}`} className="mt-0.5 text-[13px] text-orange-300" title={revAttempt?.detail}>
                            rev {q.revision} · price unchanged
                          </div>
                        )}
                        {revised && Math.abs(delta) >= 0.0005 && (
                          <div data-testid={`revised-${r.id}`} className={cx('mt-0.5 inline-flex items-center gap-1 text-[13px]', delta > 0 ? 'text-rose-300' : 'text-emerald-300')} title={revAttempt?.detail}>
                            {delta > 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                            <span className="num">
                              {delta > 0 ? '+' : ''}
                              {(delta * 100).toFixed(1)}%
                            </span>
                            <span className="text-ink-500 line-through">{inr(oldTotal)}</span>
                          </div>
                        )}
                      </td>
                      <td className="td num text-right text-ink-100">{o ? `${o.lead_time_days} d` : q ? `${q.lead_time_days} d` : '—'}</td>
                      <td className="td num text-right text-ink-100">{o ? dayMonth(o.delivery_date) : '—'}</td>
                      <td className={cx('td num text-right', !o ? 'text-ink-500' : o.float_days < 0 ? 'text-rose-300' : o.float_days < 14 ? 'text-orange-300' : 'text-emerald-300')}>{o ? signed(o.float_days) : '—'}</td>
                      <td className="td num text-right text-ink-100">{q || o ? pct(q?.reliability ?? o?.reliability ?? 0) : '—'}</td>
                      <td className="td">
                        {o ? (
                          <span data-testid={`verdict-${r.id}`} className={cx('inline-flex items-center gap-1.5 text-[13px]', TONE[VERDICT_TONE[o.budget_verdict]].text)}>
                            <span className={cx('h-2 w-2 rounded-full', TONE[VERDICT_TONE[o.budget_verdict]].dot)} />
                            {o.budget_verdict === 'ok' ? 'Within' : o.budget_verdict === 'warn' ? 'Tight' : 'Over'} · {pct(committedOf(o) / snap.goal.budget_inr)}
                          </span>
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </td>
                      <td className="td">
                        {isSel ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-accent-300">
                            <CheckCircle2 className="h-4 w-4" /> Selected
                          </span>
                        ) : isRec ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-accent-300">
                            <Award className="h-4 w-4" /> Recommended
                          </span>
                        ) : why ? (
                          <span className="text-[13px] text-rose-300">{why}</span>
                        ) : !q ? (
                          <span className="inline-flex items-center gap-1.5 text-[13px] text-orange-300">
                            <Clock className="h-3.5 w-3.5" /> {timeouts ? `No reply ×${timeouts}, retrying` : 'Waiting for reply'}
                          </span>
                        ) : (
                          <span className="text-[13px] text-ink-300">{o ? `Feasible · score ${o.score.toFixed(2)}` : 'Quoted'}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {focus && (
            <div data-testid="why-this-vendor" className="mx-5 mb-5 mt-3 rounded-xl bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-ink-50">Why {focus.vendor_name}?</span>
                <span className="text-[13px] text-ink-400">
                  score {focus.score.toFixed(2)} · cost 40 % · float 35 % · reliability 25 %
                </span>
                <span className="ml-auto">
                  <Confidence value={Math.min(0.99, 0.6 + focus.score / 2)} />
                </span>
              </div>
              <p className={cx('mt-2 text-sm leading-relaxed text-ink-200', !full && 'line-clamp-3')}>{memo && memo.recommendation === focus.option_id ? memo.reasoning : focus.rationale}</p>
            </div>
          )}
          {full && <LineComparison snap={snap} />}
        </>
      )}
    </Card>
  )
}

function LineComparison({ snap }: { snap: RunSnapshot }) {
  if (!snap.takeoff || snap.quotes.length === 0) return null
  const quotes = snap.quotes
  return (
    <div className="border-t border-white/[0.06] px-2 pb-4 pt-4">
      <h3 className="px-3 pb-2 text-sm font-semibold text-ink-100">Line-by-line unit prices</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm [&_td]:whitespace-nowrap">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="th">Item (from the spec)</th>
              <th className="th text-right">Qty</th>
              {quotes.map((q) => (
                <th key={q.vendor_id} className="th text-right">
                  {q.vendor_id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snap.takeoff.lines.map((l) => {
              const prices = quotes.map((q) => q.lines.find((x) => x.item_code === l.item_code)?.unit_price_inr)
              const min = Math.min(...prices.filter((p): p is number => p != null))
              return (
                <tr key={l.item_code} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="text-ink-100">{l.description}</div>
                    <div className="text-[13px] text-ink-400">
                      <span className="font-mono text-[12px]">{l.item_code}</span> · {l.source.split(' ').slice(1).join(' ')}
                    </div>
                  </td>
                  <td className="num px-4 py-2.5 text-right text-ink-200">
                    {l.qty} {l.unit}
                  </td>
                  {prices.map((p, i) => (
                    <td key={i} className={cx('num px-4 py-2.5 text-right', p === min ? 'text-emerald-300' : 'text-ink-200')}>
                      {p != null ? inrFull(p) : '—'}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
