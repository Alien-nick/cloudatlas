import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the demo provider.
 *
 * The demo is used rather than a live account on purpose: these assert that the
 * app renders and behaves, which must be checkable without credentials and
 * without touching anyone's AWS. The replay suite covers the live collectors.
 *
 * The epoch is pinned for the same reason it is pinned in the unit tests — the
 * demo series carry a daily cycle, so an unpinned run asserts different data
 * depending on the hour.
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev:demo',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      CLOUDATLAS_DEMO_EPOCH: String(Date.UTC(2026, 8, 21, 14, 30, 0)),
      // Exercises the degraded-scan banner, which is otherwise unreachable
      // from the demo and therefore never reviewed.
      CLOUDATLAS_DEMO_ISSUES: '1',
    },
  },
})
