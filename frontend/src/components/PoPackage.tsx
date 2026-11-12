import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckCircle2, Clock, Download, FileCheck2, FileSignature, Send, Truck } from 'lucide-react'
import type { RunSnapshot } from '../types'
import { api } from '../api'
import { cx, dateTime, fullDate, inr, inrFull } from '../lib/format'
import { Badge, Button, Card, Empty, Label } from './ui'

export function PoPackage({ snap }: { snap: RunSnapshot }) {
  const po = snap.po
  if (!po)
    return (
      <div data-testid="po-package" className="h-full">
        <Card className="h-full">
          <Empty icon={FileSignature} title="No purchase order yet" hint="The PO is drafted after the vendor-selection approval, then released after a second human sign-off." />
        </Card>
      </div>
    )
  const sent = po.status === 'sent'
  const download = async () => {
    let md = po.markdown
    try {
      const fetched = await api.poMarkdown(snap.run_id)
      if (fetched) md = fetched
    } catch {
      /* fall back to snapshot markdown */
    }
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${po.po_number}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const appr = snap.approvals.filter((a) => a.kind === 'vendor_selection' || a.kind === 'po_release')
  const stages = [
    { label: 'Drafted', done: true, icon: FileSignature },
    { label: 'Approved', done: po.status !== 'draft', icon: CheckCircle2 },
    { label: 'Sent', done: sent, icon: Send },
  ]

  return (
    <div data-testid="po-package" data-status={po.status} className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_380px] gap-4">
      <Card title={po.po_number} icon={FileCheck2} subtitle={`${po.vendor_name} · ${po.project}`} bodyClassName="overflow-auto" right={<Badge tone={sent ? 'success' : po.status === 'approved' ? 'info' : 'warning'} dot>{po.status.toUpperCase()}</Badge>}>
        <div className="relative mx-auto max-w-[980px] px-12 py-10">
          {sent && (
            <div
              data-testid="po-sent-stamp"
              className="stamp pointer-events-none absolute right-14 top-8 select-none rounded-lg border-[3px] border-emerald-400/80 px-5 py-1.5 font-mono text-[34px] font-black tracking-[0.2em] text-emerald-400/90 shadow-[0_0_40px_-8px_rgba(52,211,153,0.6)]"
              style={{ transform: 'rotate(-14deg)' }}
            >
              SENT
            </div>
          )}
          <article className="po-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{po.markdown}</ReactMarkdown>
          </article>
        </div>
      </Card>

      <div className="flex min-h-0 flex-col gap-4 overflow-auto">
        <Card title="Status" icon={Send} bodyClassName="p-4">
          <div className="flex items-center">
            {stages.map((s, i) => (
              <div key={s.label} className="flex flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={cx(
                      'grid h-9 w-9 place-items-center rounded-full ring-1 ring-inset transition',
                      s.done ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40' : 'bg-white/[0.03] text-ink-500 ring-white/10',
                    )}
                  >
                    <s.icon className="h-4 w-4" />
                  </div>
                  <span className={cx('text-[11px] font-medium', s.done ? 'text-ink-100' : 'text-ink-500')}>{s.label}</span>
                </div>
                {i < stages.length - 1 && <div className={cx('mx-2 mb-5 h-px flex-1', stages[i + 1]!.done ? 'bg-emerald-400/50' : 'bg-white/10')} />}
              </div>
            ))}
          </div>
          {po.issued_at && (
            <div className="mt-3 text-center text-[12px] text-ink-300">
              Issued <span className="num text-ink-100">{dateTime(po.issued_at)}</span> ·{' '}
              <span className="text-emerald-300">{Math.round((Date.parse(`${snap.goal.need_by}T00:00:00+05:30`) - Date.parse(po.issued_at)) / 86_400_000)} d before need-by</span>
            </div>
          )}
        </Card>

        <Card title="Totals" icon={FileSignature} bodyClassName="p-4">
          <dl className="space-y-2 text-[13px]">
            {[
              ['Subtotal', po.subtotal_inr],
              ['Freight', po.freight_inr],
              ['Expedite fee', po.expedite_fee_inr],
              ['GST', po.gst_inr],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between">
                <dt className="text-ink-400">{k as string}</dt>
                <dd className="num text-ink-100">{inrFull(v as number)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-white/[0.07] pt-3">
              <dt className="font-semibold text-ink-100">Total</dt>
              <dd data-testid="po-total" className="num text-[22px] font-semibold text-accent-300">
                {inr(po.total_inr)}
              </dd>
            </div>
            <div className="text-right font-mono text-[11px] text-ink-500">{inrFull(po.total_inr)}</div>
          </dl>
          <Button data-testid="po-download" variant="primary" icon={Download} className="mt-4 w-full" onClick={() => void download()}>
            Download PO package (.md)
          </Button>
        </Card>

        <Card title="Delivery & terms" icon={Truck} bodyClassName="space-y-3 p-4 text-[12.5px]">
          <div className="flex justify-between">
            <span className="text-ink-400">Delivery</span>
            <span className="num text-ink-100">{fullDate(po.delivery_date)}</span>
          </div>
          {snap.goal.required_on_site && (
            <div className="flex justify-between">
              <span className="text-ink-400">Required on site</span>
              <span className="num text-ink-100">{fullDate(snap.goal.required_on_site)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="shrink-0 text-ink-400">Incoterms</span>
            <span className="text-right text-ink-100">{po.incoterms}</span>
          </div>
          <div>
            <Label>Payment</Label>
            <div className="mt-1 text-ink-200">{po.payment_terms}</div>
          </div>
        </Card>

        <Card title="Approval chain" icon={CheckCircle2} bodyClassName="space-y-2.5 p-4">
          {appr.map((a) => (
            <div key={a.id} className="flex items-start gap-2.5 text-[12.5px]">
              {a.status === 'approved' ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> : <Clock className="mt-0.5 h-4 w-4 text-violet-300" />}
              <div className="min-w-0">
                <div className="text-ink-100">{a.title}</div>
                <div className="text-[11.5px] text-ink-400">
                  {a.status === 'approved' ? `${a.decided_by} · ${a.decided_at ? dateTime(a.decided_at) : ''}` : 'pending'}
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
