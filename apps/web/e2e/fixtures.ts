import { expect, type Page } from '@playwright/test'

/**
 * Get to a scanned graph.
 *
 * The first-run screen kicks off a scan whose result arrives over SSE, not over
 * `GET /api/graph` — so the reload is not incidental. Without it the assertions
 * race the stream.
 */
export async function scanned(page: Page): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto('/', { waitUntil: 'networkidle' })
  const start = page.getByRole('button', { name: /scan|start/i }).first()
  if (await start.count()) await start.click().catch(() => undefined)

  await expect(page.locator('text=prod-pg-primary').first()).toBeVisible({ timeout: 30_000 })
  // Surfaced as an assertion rather than logged: a page that renders while
  // throwing is not passing.
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
}

/** The detail panel's tab strip, which is distinct from the sidebar views. */
export function detailTab(page: Page, name: string | RegExp) {
  return page.locator('aside, [role=complementary]').last().getByRole('button', { name })
}

/**
 * Select a resource by name through the ⌘K palette.
 *
 * More robust than clicking the canvas: layout decides where a node lands, and
 * a floating notice or the minimap can sit over it.
 */
export async function selectViaPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder(/Search resources/i)
  await expect(input).toBeVisible()
  await input.fill(name)
  await expect(page.locator('[data-palette-active="true"]')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(input).toBeHidden()
}
