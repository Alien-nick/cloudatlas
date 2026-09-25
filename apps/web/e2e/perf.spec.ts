import { expect, test } from '@playwright/test'

/**
 * Render performance, measured rather than asserted from memory.
 *
 * This covers the client half of the spec's target: how long from a graph
 * arriving to a diagram you can actually use. The server half — how long a scan
 * of a real account takes — is measured by the capture tool and recorded in
 * `meta.json`, because it cannot be measured honestly against fixtures.
 *
 * The budgets are deliberately loose. A tight budget on a shared CI machine
 * fails for reasons that have nothing to do with the code, and a perf test that
 * cries wolf gets skipped. These are set to catch an order-of-magnitude
 * regression, and the measured numbers are printed either way so a gradual
 * drift is visible in the log before it trips anything.
 */

/** Generous: catches a 10x regression, not a slow laptop. */
const FIRST_RENDER_BUDGET_MS = 20_000
const INTERACTION_BUDGET_MS = 3_000

test('renders the demo topology within budget', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })

  const started = Date.now()
  const start = page.getByRole('button', { name: /scan|start/i }).first()
  if (await start.count()) await start.click().catch(() => undefined)

  // "Usable" means a resource is on screen and clickable, not that a request
  // finished — the layout runs in a worker after the graph arrives.
  await expect(page.locator('text=prod-pg-primary').first()).toBeVisible({ timeout: 30_000 })
  const firstRender = Date.now() - started

  const nodeCount = await page.locator('.vue-flow__node').count()
  const edgeCount = await page.locator('.vue-flow__edge').count()

  const selectStarted = Date.now()
  await page.locator('text=prod-pg-primary').first().click()
  await expect(page.locator('text=PostgreSQL').first()).toBeVisible()
  const selectMs = Date.now() - selectStarted

  const paletteStarted = Date.now()
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder(/Search resources/i)
  await expect(input).toBeVisible()
  await input.fill('prod')
  await expect(page.locator('[data-palette-active="true"]')).toBeVisible()
  const paletteMs = Date.now() - paletteStarted

  console.log(
    `\n  perf: ${nodeCount} nodes / ${edgeCount} edges` +
      `\n    scan to usable diagram  ${firstRender} ms` +
      `\n    select a resource       ${selectMs} ms` +
      `\n    palette open + filter   ${paletteMs} ms\n`,
  )

  expect(nodeCount).toBeGreaterThan(20)
  expect(firstRender).toBeLessThan(FIRST_RENDER_BUDGET_MS)
  expect(selectMs).toBeLessThan(INTERACTION_BUDGET_MS)
  expect(paletteMs).toBeLessThan(INTERACTION_BUDGET_MS)
})
