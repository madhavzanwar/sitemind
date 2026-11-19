import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// End-to-end against the real backend (or the in-browser mock with E2E_MOCK=1).
const MOCK = process.env.E2E_MOCK === '1'
const SHOTS = resolve(HERE, '..', 'docs', 'screenshots')
mkdirSync(SHOTS, { recursive: true })
// Real-backend screenshots are saved as docs/screenshots/real-*.png (mock ones come from screenshots.spec.ts).
const shot = async (page: Page, name: string) => {
  if (MOCK) return
  await page.mouse.move(0, 899)
  await page.waitForTimeout(400) // let CSS transitions settle
  await page.screenshot({ path: join(SHOTS, `real-${name}.png`) })
}

const status = (page: Page) => page.getByTestId('run-status')
const home = (page: Page) => page.goto(MOCK ? '/?mock_delay=350' : '/')

async function approvePending(page: Page, kind: 'vendor_selection' | 'po_release', comment?: string) {
  await page.getByTestId('tab-approvals').click()
  const detail = page.getByTestId('approval-detail')
  await expect(detail).toHaveAttribute('data-kind', kind, { timeout: 120_000 })
  await expect(detail).toHaveAttribute('data-status', 'pending')
  if (comment) await page.getByTestId('approval-comment').fill(comment)
  await page.getByTestId('approve-button').click()
}

test('launch, survive SIGKILL, approve twice, PO sent', async ({ page }) => {
  await home(page)
  await expect(page.getByTestId('goal-input')).toHaveValue(/480 V switchgear/)
  await expect(page.getByTestId('budget-input')).toHaveValue('4,60,00,000')
  await expect(page.getByTestId('chip-budget_inr')).toHaveAttribute('data-state', 'found')
  await shot(page, 'landing')
  await page.getByTestId('launch-button').click()

  await expect(status(page)).toBeVisible()
  for (const id of ['task-graph', 'timeline', 'vendor-table', 'budget-chart', 'event-console']) await expect(page.getByTestId(id)).toBeVisible()
  await expect(page.getByTestId('sim-clock')).toContainText('2027')
  await expect(page.getByTestId('run-package')).toContainText('480 V switchgear')

  // kill the worker mid-run
  await expect.poll(async () => page.locator('[data-testid^="task-"][data-status="done"]').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  await page.getByTestId('kill-button').click()
  await expect(status(page)).toHaveAttribute('data-status', 'killed')
  await expect(page.getByTestId('killed-banner')).toBeVisible()
  await expect(page.getByTestId('worker-status')).toHaveAttribute('data-alive', 'false')
  await shot(page, 'killed')
  const frozenClock = await page.getByTestId('sim-clock').textContent()
  await page.waitForTimeout(2_000)
  await expect(page.getByTestId('sim-clock')).toHaveText(frozenClock ?? '')

  await page.getByTestId('resume-button').click()
  await expect(status(page)).not.toHaveAttribute('data-status', 'killed')
  await expect(page.getByTestId('toast').filter({ hasText: 'Resumed from checkpoint' })).toBeVisible()
  await expect(page.getByTestId('killed-banner')).toHaveCount(0)

  // approval 1: vendor selection (Now bar CTA)
  await expect(status(page)).toHaveAttribute('data-status', 'waiting_human', { timeout: 120_000 })
  const vendors = page.getByTestId('vendor-table')
  await expect(vendors.getByText('Selected', { exact: true })).toHaveCount(0)
  await expect(vendors.getByText('Recommended', { exact: true })).toHaveCount(1)
  await shot(page, 'overview-waiting')
  await page.getByTestId('now-approve').click()
  await expect(page.getByTestId('approvals-inbox')).toBeVisible()
  await shot(page, 'approvals-vendor')
  await approvePending(page, 'vendor_selection', 'Approved by e2e — tie any fee to the delivery milestone.')

  // approval 2: PO release
  await expect(page.getByTestId('approval-detail')).toHaveAttribute('data-kind', 'po_release', { timeout: 120_000 })
  await shot(page, 'approvals-po')
  await approvePending(page, 'po_release')

  await page.getByTestId('tab-overview').click()
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 })
  await expect(page.getByTestId('vendor-table').getByText('Selected', { exact: true })).toHaveCount(1)
  await shot(page, 'overview-completed')
  await page.getByTestId('tab-po').click()
  await expect(page.getByTestId('po-package')).toHaveAttribute('data-status', 'sent')
  await expect(page.getByTestId('po-sent-stamp')).toHaveText('SENT')
  await shot(page, 'po')

  await page.getByTestId('tab-plan').click()
  await page.locator('[data-testid="task-T1-takeoff"]').click()
  await expect(page.getByTestId('detail-drawer')).toBeVisible()
  await expect(page.getByTestId('task-audit')).toBeVisible()
  await shot(page, 'task-drawer')
  await page.keyboard.press('Escape')

  await page.getByTestId('tab-audit').click()
  await expect(page.getByTestId('audit-table')).toBeVisible()
  await shot(page, 'audit')
  await page.getByTestId('audit-view-ledger').click()
  await expect(page.getByTestId('ledger-table')).toContainText('po.sent')
  await expect(page.getByTestId('dedup-banner')).toBeVisible()
  await shot(page, 'ledger')
})

test('price change on the recommended vendor supersedes the pending approval', async ({ page }) => {
  await home(page)
  await page.getByTestId('launch-button').click()
  await expect(status(page)).toHaveAttribute('data-status', 'waiting_human', { timeout: 150_000 })
  await page.getByTestId('tab-approvals').click()
  const firstMemo = await page.getByTestId('approval-detail').locator('h2').textContent()
  await page.getByTestId('tab-overview').click()

  const consoleEl = page.getByTestId('event-console')
  await consoleEl.getByTestId('event-type').selectOption('price_change')
  // the vendor picker defaults to the recommended vendor
  await expect(consoleEl.getByTestId('event-vendor')).toContainText('(recommended)')
  await consoleEl.getByTestId('event-param-pct').fill('25')
  await consoleEl.getByTestId('event-note').fill('Steel surcharge notified by phone')
  await consoleEl.getByTestId('inject-event').click()

  const item = page.getByTestId('event-feed').getByTestId('event-item').first()
  await expect(item).toHaveAttribute('data-type', 'price_change')
  await expect(item).toHaveAttribute('data-status', 'applied', { timeout: 120_000 })
  await expect(page.getByTestId('timeline-event-marker').first()).toBeVisible()
  await shot(page, 'event-console')

  await page.getByTestId('tab-approvals').click()
  await expect(page.locator('[data-testid="approval-item-vendor_selection"][data-status="superseded"]').first()).toBeVisible({ timeout: 120_000 })
  const detail = page.getByTestId('approval-detail')
  await expect(detail).toHaveAttribute('data-kind', 'vendor_selection', { timeout: 120_000 })
  await expect(detail).toHaveAttribute('data-status', 'pending')
  expect(firstMemo).toBeTruthy()
  await shot(page, 'approvals-superseded')
})

test('a second package (2 MW DG sets) runs end to end', async ({ page }) => {
  await home(page)
  await page.getByTestId('package-card-dg-2mw').click()
  await expect(page.getByTestId('goal-input')).toHaveValue(/DG sets/)
  await expect(page.getByTestId('chip-package')).toContainText('DG')
  await expect(page.getByTestId('package-select')).toHaveValue('dg-2mw')
  await shot(page, 'dg-landing')
  await page.getByTestId('launch-button').click()
  await expect(page.getByTestId('run-package')).toContainText('DG sets')

  // approve whatever the agent asks until the run completes
  const deadline = Date.now() + 200_000
  let shotTaken = false
  while (Date.now() < deadline) {
    const st = await status(page).getAttribute('data-status')
    if (st === 'completed') break
    if (st === 'waiting_human') {
      if (!shotTaken) {
        await shot(page, 'dg-overview-waiting')
        shotTaken = true
      }
      await page.getByTestId('tab-approvals').click()
      const detail = page.getByTestId('approval-detail')
      if ((await detail.getAttribute('data-status')) === 'pending') await page.getByTestId('approve-button').click()
      await page.waitForTimeout(800)
      await page.getByTestId('tab-overview').click()
    }
    await page.waitForTimeout(700)
  }
  await expect(status(page)).toHaveAttribute('data-status', 'completed')
  await shot(page, 'dg-overview-completed')
  await page.getByTestId('tab-po').click()
  await expect(page.getByTestId('po-package')).toHaveAttribute('data-status', 'sent')
  await shot(page, 'dg-po')
})
