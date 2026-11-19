import { test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Mock-mode screenshots of every screen (E2E_MOCK=1 only). Laptop first: 1440×900 is the
// canonical set; key screens are repeated at 1366×768 and 1920×1080.
const SHOTS = resolve(HERE, '..', 'docs', 'screenshots')
mkdirSync(SHOTS, { recursive: true })

test.skip(process.env.E2E_MOCK !== '1', 'mock-mode screenshots only')

const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1200)
}

const cases: [string, string, boolean?][] = [
  ['landing', '/'],
  ['overview-planning', '/?fixture=planning'],
  ['overview-quotes', '/?fixture=quotes'],
  ['overview-replan', '/?fixture=replan'],
  ['overview-killed', '/?fixture=killed'],
  ['overview-approval', '/?fixture=approval'],
  ['overview-approval-full', '/?fixture=approval', true],
  ['overview-event', '/?fixture=event', true],
  ['overview-completed', '/?fixture=completed'],
  ['plan', '/?fixture=event&tab=plan', true],
  ['vendors', '/?fixture=event&tab=vendors', true],
  ['approvals-vendor', '/?fixture=approval&tab=approvals'],
  ['approvals-superseded', '/?fixture=event&tab=approvals'],
  ['approvals-po', '/?fixture=po-approval&tab=approvals'],
  ['audit', '/?fixture=completed&tab=audit'],
  ['po', '/?fixture=completed&tab=po'],
  ['dg-overview-approval', '/?fixture=dg-approval', true],
  ['dg-po', '/?fixture=dg-completed&tab=po'],
]

const viewports: [string, number, number, string[]][] = [
  ['', 1440, 900, cases.map((c) => c[0])],
  ['@1366', 1366, 768, ['landing', 'overview-approval', 'approvals-vendor', 'overview-killed', 'vendors']],
  ['@1920', 1920, 1080, ['landing', 'overview-approval', 'overview-completed', 'approvals-vendor', 'dg-overview-approval']],
]

for (const [suffix, w, h, names] of viewports) {
  for (const [name, url, full] of cases.filter((c) => names.includes(c[0]))) {
    test(`screenshot ${name}${suffix}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h })
      await page.goto(url)
      await settle(page)
      await page.screenshot({ path: join(SHOTS, `${name}${suffix}.png`), fullPage: !!full && suffix === '' })
    })
  }
}

test('screenshot ledger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?fixture=completed&tab=audit')
  await page.getByTestId('audit-view-ledger').click()
  await settle(page)
  await page.screenshot({ path: join(SHOTS, 'ledger.png') })
})

test('screenshot task drawer + timeline moment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?fixture=approval&tab=plan')
  await page.locator('[data-testid="task-T1-takeoff"]').click()
  await settle(page)
  await page.screenshot({ path: join(SHOTS, 'task-drawer.png') })
  await page.keyboard.press('Escape')
  await page.getByTestId('tab-overview').click()
  await page.locator('[data-testid="timeline"] g[data-kind="error"]').first().click()
  await settle(page)
  await page.screenshot({ path: join(SHOTS, 'timeline-moment.png') })
})

test('screenshot event console + why popover', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?fixture=event')
  await settle(page)
  await page.getByTestId('event-console').screenshot({ path: join(SHOTS, 'event-console.png') })
  await page.getByTestId('why-vendor').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, 'why-popover.png') })
})

test('screenshot goal parse: missing fields + unsupported handoff + upload preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByTestId('goal-input').fill('Order the DG sets for Project Alpha soon')
  await settle(page)
  await page.getByTestId('composer').screenshot({ path: join(SHOTS, 'goal-missing-fields.png') })
  await page.getByTestId('goal-input').fill('Get the chillers for Project Alpha ordered by 2027-05-01 within budget ₹12 Cr')
  await settle(page)
  await page.getByTestId('composer').screenshot({ path: join(SHOTS, 'goal-unsupported-handoff.png') })
  await page.getByTestId('package-card-dg-2mw').click()
  await page.getByTestId('spec-file').setInputFiles({ name: 'alpha_dg_spec_rev_B.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 mock') })
  await page.waitForTimeout(1200)
  await settle(page)
  await page.getByTestId('composer').screenshot({ path: join(SHOTS, 'spec-upload-preview.png') })
})
