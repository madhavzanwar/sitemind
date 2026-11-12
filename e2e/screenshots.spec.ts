import { test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Mock-mode screenshots of every screen at 1920x1080 (E2E_MOCK=1 only).
const SHOTS = resolve(HERE, '..', 'docs', 'screenshots')
mkdirSync(SHOTS, { recursive: true })

const cases: [string, string][] = [
  ['landing', '/'],
  ['overview-planning', '/?fixture=planning'],
  ['overview-quotes', '/?fixture=quotes'],
  ['overview-replan', '/?fixture=replan'],
  ['overview-killed', '/?fixture=killed'],
  ['overview-approval', '/?fixture=approval'],
  ['overview-completed', '/?fixture=completed'],
  ['approvals-vendor', '/?fixture=approval&tab=approvals'],
  ['approvals-po', '/?fixture=po-approval&tab=approvals'],
  ['audit', '/?fixture=completed&tab=audit'],
  ['po', '/?fixture=completed&tab=po'],
]

test.skip(process.env.E2E_MOCK !== '1', 'mock-mode screenshots only')

for (const [name, url] of cases) {
  test(`screenshot ${name}`, async ({ page }) => {
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  })
}

test('screenshot ledger', async ({ page }) => {
  await page.goto('/?fixture=completed&tab=audit')
  await page.getByTestId('audit-view-ledger').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, 'ledger.png') })
})
