import { useMemo, useState } from 'react'
import { AlertTriangle, Award, Check, CheckCircle2, FileSignature, HelpCircle, Inbox, Lightbulb, ListChecks, ShieldAlert, X, XCircle } from 'lucide-react'
import type { ApprovalDecision, ApprovalRequest, RunSnapshot } from '../types'
import { cx, dateTime, dayMonth, inr, inrFull, pct, signed } from '../lib/format'
import { VERDICT_TONE } from '../lib/status'
import { Badge, Button, Card, Empty, Label } from './ui'

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  vendor_selection: 'Vendor selection',
  po_release: 'PO release',
  budget_exception: 'Budget exception',
  deadline_risk: 'Deadline risk',
}

export function Approvals({
  snap,
  onDecide,
  busy,
}: {
  snap: RunSnapshot
  onDecide: (approvalId: string, d: ApprovalDecision) => Promise<void>
  busy: boolean
}) {
  const pending = snap.approvals.filter((a) => a.status === 'pending')
  const decided = snap.approvals.filter((a) => a.status !== 'pending').reverse()
  const [selId, setSelId] = useState<string | null>(null)
  const sel = snap.approvals.find((a) => a.id === selId) ?? pending[0] ?? decided[0] ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-[380px_minmax(0,1fr)] gap-4" data-testid="approvals-inbox">
      <Card title="Inbox" icon={Inbox} subtitle={`${pending.length} pending`} bodyClassName="overflow-auto p-3">
        {snap.approvals.length === 0 ? (
          <Empty icon={Inbox} title="Nothing to approve" hint="The agent asks for a human decision before selecting a vendor and before releasing the PO." />
        ) : (
          <div className="flex flex-col gap-2">
            {pending.length > 0 && <Label className="px-1 pb-0.5">Pending</Label>}
            {pending.map((a) => (
              <Item key={a.id} a={a} active={sel?.id === a.id} onClick={() => setSelId(a.id)} />
            ))}
            {decided.length > 0 && <Label className="px-1 pb-0.5 pt-3">History</Label>}
            {decided.map((a) => (
              <Item key={a.id} a={a} active={sel?.id === a.id} onClick={() => setSelId(a.id)} />
            ))}
          </div>
        )}
      </Card>
      <div className="min-h-0 overflow-auto">
        {sel ? <Detail key={sel.id} a={sel} snap={snap} onDecide={onDecide} busy={busy} /> : <Card><Empty icon={Inbox} title="No approval selected" /></Card>}
      </div>
    </div>
  )
}

function Item({ a, active, onClick }: { a: ApprovalRequest; active: boolean; onClick: () => void }) {
  const tone = a.status === 'pending' ? 'human' : a.status === 'approved' ? 'success' : 'danger'
  return (
    <button
      onClick={onClick}
      data-testid={`approval-item-${a.kind}`}
      className={cx(
        'w-full rounded-xl border p-3 text-left transition',
        active ? 'border-accent-400/40 bg-accent-400/[0.05]' : 'border-white/[0.06] bg-ink-850/60 hover:border-white/15',
      )}
    >
      <div className="flex items-center gap-2">
        <Badge tone={tone} dot>
          {a.status}
        </Badge>
        <span className="text-[11px] font-medium text-ink-400">{KIND_LABEL[a.kind]}</span>
        <span className="num ml-auto text-[10.5px] text-ink-500">{dateTime(a.requested_at)}</span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink-50">{a.title}</div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-300">{a.summary}</div>
    </button>
  )
}

function Detail({
  a,
  snap,
  onDecide,
  busy,
}: {
  a: ApprovalRequest
  snap: RunSnapshot
  onDecide: (approvalId: string, d: ApprovalDecision) => Promise<void>
  busy: boolean
}) {
  const memo = a.memo
  const options = useMemo(() => memo?.options ?? [], [memo])
  const [opt, setOpt] = useState<string | null>(a.decided_option ?? memo?.recommendation ?? a.options[0] ?? null)
  const [comment, setComment] = useState('')
  const pending = a.status === 'pending'
  const killed = snap.status === 'killed'
  const decide = (decision: 'approve' | 'reject') =>
    onDecide(a.id, { decision, option_id: a.kind === 'vendor_selection' ? opt : null, comment: comment || null })

  return (
    <Card
      title={a.title}
      icon={a.kind === 'po_release' ? FileSignature : Award}
      subtitle={memo?.memo_id ?? a.po?.po_number}
      right={
        <Badge tone={pending ? 'human' : a.status === 'approved' ? 'success' : 'danger'} dot>
          {pending ? 'Awaiting decision' : `${a.status} by ${a.decided_by ?? '—'}`}
        </Badge>
      }
      bodyClassName="p-6"
      testId="approval-detail"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-8">
        <div className="min-w-0 space-y-6">
          {memo ? (
            <>
              <Section icon={HelpCircle} title="Situation">
                <p className="text-[14px] leading-relaxed text-ink-200">{memo.situation}</p>
              </Section>
              <Section icon={ListChecks} title="Options">
                <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                  <table className="w-full text-[12.5px]">
                    <thead className="bg-white/[0.025]">
                      <tr>
                        <th className="th w-10" />
                        <th className="th">Option</th>
                        <th className="th text-right">Total</th>
                        <th className="th text-right">Lead</th>
                        <th className="th text-right">Delivery</th>
                        <th className="th text-right">Float</th>
                        <th className="th text-right">Reliab.</th>
                        <th className="th">Budget</th>
                        <th className="th text-right">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {options.map((o) => {
                        const allowed = a.options.length === 0 || a.options.includes(o.option_id)
                        const checked = opt === o.option_id
                        return (
                          <tr
                            key={o.option_id}
                            onClick={() => pending && allowed && setOpt(o.option_id)}
                            data-testid={`option-${o.option_id}`}
                            className={cx(
                              'border-t border-white/[0.05] transition',
                              checked && 'bg-accent-400/[0.06]',
                              allowed && pending ? 'cursor-pointer hover:bg-white/[0.02]' : !allowed && 'opacity-50',
                            )}
                          >
                            <td className="td">
                              <input
                                type="radio"
                                name={`opt-${a.id}`}
                                aria-label={`Select ${o.vendor_name}`}
                                checked={checked}
                                disabled={!pending || !allowed}
                                onChange={() => setOpt(o.option_id)}
                                className="h-4 w-4 accent-[#FFB224]"
                              />
                            </td>
                            <td className="td">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-ink-400">{o.option_id}</span>
                                <span className="font-semibold text-ink-50">{o.vendor_name}</span>
                                {o.option_id === memo.recommendation && (
                                  <Badge tone="accent">
                                    <Award className="h-3 w-3" /> Recommended
                                  </Badge>
                                )}
                              </div>
                              {o.expedite_fee_inr > 0 && <div className="mt-0.5 text-[11px] text-sky-300">incl. expedite {inr(o.expedite_fee_inr)}</div>}
                            </td>
                            <td className="td num text-right text-ink-50">{inr(o.total_inr)}</td>
                            <td className="td num text-right">{o.lead_time_days} d</td>
                            <td className="td num text-right">{dayMonth(o.delivery_date)}</td>
                            <td className={cx('td num text-right', o.float_days < 0 ? 'text-rose-300' : o.float_days < 14 ? 'text-orange-300' : 'text-emerald-300')}>
                              {signed(o.float_days)}
                            </td>
                            <td className="td num text-right">{pct(o.reliability)}</td>
                            <td className="td">
                              <Badge tone={VERDICT_TONE[o.budget_verdict]} dot>
                                {o.budget_verdict}
                              </Badge>
                            </td>
                            <td className="td num text-right font-semibold text-ink-50">{o.score.toFixed(2)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
              <div className="grid grid-cols-2 gap-6">
                <Section icon={Lightbulb} title="Recommendation & reasoning">
                  <p className="text-[13.5px] leading-relaxed text-ink-200">{memo.reasoning}</p>
                </Section>
                <Section icon={ShieldAlert} title="Risks">
                  <ul className="space-y-2">
                    {memo.risks.map((r, i) => (
                      <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink-200">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-300" />
                        {r}
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            </>
          ) : a.po ? (
            <PoSummary a={a} />
          ) : (
            <p className="text-sm text-ink-300">{a.summary}</p>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4">
            <Label className="text-violet-300">The ask</Label>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-100">{memo?.asks ?? a.summary}</p>
          </div>
          {pending ? (
            <div className="space-y-3 rounded-xl border border-white/[0.06] bg-ink-850/60 p-4">
              {a.kind === 'vendor_selection' && opt && (
                <div className="text-[12.5px] text-ink-300">
                  Selected: <span className="font-semibold text-ink-50">{options.find((o) => o.option_id === opt)?.vendor_name ?? opt}</span>
                </div>
              )}
              <label className="block">
                <Label>Comment</Label>
                <textarea
                  data-testid="approval-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder="Optional note for the audit trail…"
                  className="field mt-1.5 resize-none"
                />
              </label>
              <div className="flex gap-2">
                <Button data-testid="approve-button" variant="success" icon={Check} className="flex-1" disabled={busy} onClick={() => void decide('approve')}>
                  Approve
                </Button>
                <Button data-testid="reject-button" variant="secondary" icon={X} disabled={busy} onClick={() => void decide('reject')}>
                  Reject
                </Button>
              </div>
              {killed && <p className="text-[11.5px] leading-snug text-orange-300">Worker is offline — your decision is stored and the run resumes from its checkpoint.</p>}
              <p className="text-[11px] text-ink-500">Decision is recorded with idempotency key {a.id}</p>
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-white/[0.06] bg-ink-850/60 p-4 text-[12.5px]">
              <div className="flex items-center gap-2 font-semibold">
                {a.status === 'approved' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-rose-400" />}
                <span className="capitalize text-ink-50">{a.status}</span>
                {a.decided_at && <span className="num ml-auto text-[11px] font-normal text-ink-400">{dateTime(a.decided_at)}</span>}
              </div>
              {a.decided_option && <div className="text-ink-300">Option <span className="font-mono text-ink-100">{a.decided_option}</span></div>}
              <div className="text-ink-300">By {a.decided_by}</div>
              {a.comment && <div className="rounded-lg bg-white/[0.03] p-2 italic text-ink-200">“{a.comment}”</div>}
            </div>
          )}
        </aside>
      </div>
    </Card>
  )
}

function PoSummary({ a }: { a: ApprovalRequest }) {
  const po = a.po!
  return (
    <div className="space-y-5">
      <Section icon={FileSignature} title={`${po.po_number} · ${po.vendor_name}`}>
        <p className="text-[14px] leading-relaxed text-ink-200">{a.summary}</p>
      </Section>
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <table className="w-full text-[12.5px]">
          <thead className="bg-white/[0.025]">
            <tr>
              <th className="th">#</th>
              <th className="th">Item</th>
              <th className="th">Description</th>
              <th className="th text-right">Qty</th>
              <th className="th text-right">Unit</th>
              <th className="th text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.line_no} className="border-t border-white/[0.05]">
                <td className="td num text-ink-400">{l.line_no}</td>
                <td className="td font-mono text-[11.5px] text-accent-200">{l.item_code}</td>
                <td className="td text-ink-200">{l.description}</td>
                <td className="td num text-right">{l.qty}</td>
                <td className="td num text-right">{inrFull(l.unit_price_inr)}</td>
                <td className="td num text-right text-ink-50">{inrFull(l.total_inr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-5 gap-3">
        {[
          ['Subtotal', po.subtotal_inr],
          ['Freight', po.freight_inr],
          ['Expedite', po.expedite_fee_inr],
          ['GST', po.gst_inr],
          ['Total', po.total_inr],
        ].map(([k, v]) => (
          <div key={k as string} className={cx('rounded-xl border p-3', k === 'Total' ? 'border-accent-400/30 bg-accent-400/[0.05]' : 'border-white/[0.06] bg-ink-850/60')}>
            <Label>{k as string}</Label>
            <div className={cx('num mt-1 text-[15px] font-semibold', k === 'Total' ? 'text-accent-300' : 'text-ink-50')}>{inr(v as number)}</div>
          </div>
        ))}
      </div>
      <div className="text-[12.5px] text-ink-300">
        Delivery <span className="text-ink-100">{dayMonth(po.delivery_date)}</span> · {po.incoterms} · {po.payment_terms}
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: typeof Inbox; title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-accent-400" />
        <Label>{title}</Label>
      </div>
      {children}
    </section>
  )
}
