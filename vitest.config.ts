import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
      // apps/web was missing here, so a web test file ran only when named
      // explicitly on the command line — which means it would have passed
      // review, been committed, and then never run again.
      'apps/web/src/**/*.test.ts',
    ],
    passWithNoTests: false,
    // The demo provider's series depend on absolute time, including a daily
    // cycle. Pinning the epoch makes every demo-derived assertion reproducible
    // instead of quietly depending on the hour the suite ran.
    env: { CLOUDATLAS_DEMO_EPOCH: String(Date.UTC(2026, 8, 21, 14, 30, 0)) },
  },
  resolve: {
    // Matches the Vite alias in apps/web, so a test can import the same way the
    // components do.
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
})
