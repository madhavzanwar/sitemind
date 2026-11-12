import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Two modes:
//  - default: real FastAPI backend (serves the built frontend from frontend/dist) on :8000
//  - E2E_MOCK=1: Vite dev server with the in-browser mock backend on :5175
const MOCK = process.env.E2E_MOCK === '1'
const ROOT = resolve(HERE, '..')
const PORT = MOCK ? 5175 : Number(process.env.E2E_PORT ?? 8000)
const dataDir = process.env.SITEMIND_DATA ?? mkdtempSync(join(tmpdir(), 'sitemind-e2e-'))
const python = process.env.PYTHON ?? 'python3'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1920, height: 1080 },
    trace: 'off',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { viewport: { width: 1920, height: 1080 } } }],
  webServer: MOCK
    ? {
        command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
        cwd: join(ROOT, 'frontend'),
        env: { VITE_MOCK: '1' },
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }
    : {
        command: `npm --prefix ../frontend run build && ${python} -m uvicorn sitemind.api:app --host 127.0.0.1 --port ${PORT}`,
        cwd: join(ROOT, 'backend'),
        env: {
          SITEMIND_LLM_PROVIDER: 'off',
          SITEMIND_STEP_DELAY: process.env.SITEMIND_STEP_DELAY ?? '0.3',
          SITEMIND_DATA: dataDir,
        },
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 180_000,
      },
})
