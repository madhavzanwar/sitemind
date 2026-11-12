import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Full happy path of the demo scenario against the real backend (or the in-browser mock with
// E2E_MOCK=1): launch -> SIGKILL mid-run -> resume -> approve vendor -> approve PO -> SENT.
const MOCK = process.env.E2E_MOCK === '1'
const SHOTS = resolve(HERE, '..', 'docs', 'screenshots')
mkdirSync(SHOTS, { recursive: true })
// Real-backend screenshots are saved as docs/screenshots/real-*.png (mock ones come from screenshots.spec.ts).
const shot = async (page: Page, name: string) => {
  if (!MOCK) await page.screenshot({ path: join(SHOTS, `real-${name}.png`) })
}

const status = (page: Page) => page.getByTestId('run-status')

test('launch, survive SIGKILL, approve twice, PO sent', async ({ page }) => {
  await page.goto(MOCK ? '/?mock_delay=350' : '/')

  // --- goal composer (prefilled from /api/demo/defaults)
  await expect(page.getByTestId('goal-input')).toHaveValue(/480 V switchgear/)
  await expect(page.getByTestId('budget-input')).toHaveValue('4,60,00,000')
  await page.getByTestId('launch-button').click()

  // --- run view
  await expect(status(page)).toBeVisible()
  await expect(page.getByTestId('task-graph')).toBeVisible()
  await expect(page.getByTestId('timeline')).toBeVisible()
  await expect(page.getByTestId('vendor-table')).toBeVisible()
  await expect(page.getByTestId('budget-chart')).toBeVisible()
  await expect(page.getByTestId('sim-clock')).toContainText('2027')

  // --- kill the worker mid-run (once a couple of tasks are done)
  await expect.poll(async () => page.locator('[data-testid^="task-"][data-status="done"]').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.getByTestId('kill-button')).toBeEnabled()
  await page.getByTestId('kill-button').click()
  await expect(status(page)).toHaveAttribute('data-status', 'killed')
  await expect(page.getByTestId('killed-banner')).toBeVisible()
  await expect(page.getByTestId('worker-status')).toHaveAttribute('data-alive', 'false')
  await shot(page, 'killed')

  // progress is frozen while killed
  const frozenClock = await page.getByTestId('sim-clock').textContent()
  await page.waitForTimeout(2_000)
  await expect(page.getByTestId('sim-clock')).toHaveText(frozenClock ?? '')

  // --- resume from checkpoint
  await page.getByTestId('resume-button').click()
  await expect(status(page)).not.toHaveAttribute('data-status', 'killed')
  await expect(page.getByTestId('toast').filter({ hasText: 'Resumed from checkpoint' })).toBeVisible()
  await expect(page.getByTestId('killed-banner')).toHaveCount(0)

  // --- approval 1: vendor selection
  await expect(status(page)).toHaveAttribute('data-status', 'waiting_human', { timeout: 120_000 })
  await shot(page, 'overview-waiting')
  await page.getByTestId('tab-approvals').click()
  await expect(page.getByTestId('approvals-inbox')).toBeVisible()
  const detail = page.getByTestId('approval-detail')
  await expect(detail).toHaveAttribute('data-kind', 'vendor_selection')
  await expect(detail).toHaveAttribute('data-status', 'pending')
  await shot(page, 'approvals-vendor')
  await page.getByTestId('approval-comment').fill('Approved by e2e — tie expedite fee to delivery milestone.')
  await page.getByTestId('approve-button').click()

  // --- approval 2: PO release
  await expect(detail).toHaveAttribute('data-kind', 'po_release', { timeout: 120_000 })
  await expect(detail).toHaveAttribute('data-status', 'pending')
  await shot(page, 'approvals-po')
  await page.getByTestId('approve-button').click()

  // --- completed + PO SENT
  await page.getByTestId('tab-overview').click()
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 })
  await shot(page, 'overview-completed')
  await page.getByTestId('tab-po').click()
  const po = page.getByTestId('po-package')
  await expect(po).toHaveAttribute('data-status', 'sent')
  await expect(page.getByTestId('po-sent-stamp')).toHaveText('SENT')
  await expect(po).toContainText('Purchase Order')
  await shot(page, 'po')

  // --- audit + ledger show the kill/resume and idempotent side effects
  await page.getByTestId('tab-audit').click()
  await expect(page.getByTestId('audit-table')).toBeVisible()
  await shot(page, 'audit')
  await page.getByTestId('audit-view-ledger').click()
  await expect(page.getByTestId('ledger-table')).toContainText('po.sent')
  await shot(page, 'ledger')
})
