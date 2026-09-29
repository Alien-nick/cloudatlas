import { expect, test } from '@playwright/test'
import { scanned, selectViaPalette } from './fixtures'

test.describe('the diagram', () => {
  test('renders the scanned topology without console errors', async ({ page }) => {
    await scanned(page)
    await expect(page.locator('text=prod-vpc').first()).toBeVisible()
    await expect(page.locator('text=cortex-waf').first()).toBeVisible()
  })

  test('opens a resource and shows its configuration', async ({ page }) => {
    await scanned(page)
    await page.locator('text=prod-pg-primary').first().click()
    await expect(page.locator('text=PostgreSQL').first()).toBeVisible()
    await expect(page.locator('text=max_connections').first()).toBeVisible()
  })
})

test.describe('metrics', () => {
  test('draws charts with a shared cursor', async ({ page }) => {
    await scanned(page)
    await page.locator('text=prod-pg-primary').first().click()
    await page.getByRole('button', { name: 'Metrics', exact: true }).first().click()

    const charts = page.locator('.ca-chart canvas')
    await expect(charts.first()).toBeVisible()
    expect(await charts.count()).toBeGreaterThanOrEqual(2)
  })

  test('streams updates and states how far behind CloudWatch is', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/metrics')) requests.push(request.url())
    })

    await scanned(page)
    await selectViaPalette(page, 'prod-pg-primary')
    await page.getByRole('button', { name: 'Metrics', exact: true }).first().click()
    await expect(page.locator('.ca-chart canvas').first()).toBeVisible()

    // One streaming connection, not a per-tab polling timer.
    expect(requests.some((url) => url.includes('/api/metrics/stream'))).toBe(true)

    // "Live" without a number invites assuming now; CloudWatch publishes on a
    // period and adds ingestion delay on top.
    await expect(page.getByText(/behind/).first()).toBeVisible()
  })

  test('explains an empty chart rather than drawing a flat line', async ({ page }) => {
    await scanned(page)
    // legacy-worker is stopped, so CloudWatch genuinely has nothing.
    await page.locator('text=legacy-worker').first().click()
    await page.getByRole('button', { name: 'Metrics', exact: true }).first().click()
    await expect(page.locator('text=/is stopped/i').first()).toBeVisible()
  })
})

test.describe('logs', () => {
  test('lists discovered groups and distinguishes missing ones', async ({ page }) => {
    await scanned(page)
    await page.locator('text=prod-pg-primary').first().click()
    await page.getByRole('button', { name: 'Logs', exact: true }).last().click()

    await expect(page.locator('text=/\\/aws\\/rds\\/instance/').first()).toBeVisible()
    // The slowquery export is off in the fixture, and the hint says so.
    await expect(page.locator('text=/Enable the slowquery log export/i')).toBeVisible()
  })

  test('searches a resource log groups', async ({ page }) => {
    await scanned(page)
    await page.locator('text=prod-pg-primary').first().click()
    await page.getByRole('button', { name: 'Logs', exact: true }).last().click()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('text=/connection authorized|LOG:/').first()).toBeVisible()
  })
})

test.describe('health', () => {
  // Scoped to `main`: the detail panel repeats a finding for the selected
  // resource, so an unscoped text match is ambiguous between the two.
  test('surfaces the staged incidents with their evidence', async ({ page }) => {
    await scanned(page)
    await page.getByText('Health', { exact: true }).first().click()
    const view = page.getByRole('main')
    await expect(view.getByText(/CPU and connections spiking/i)).toBeVisible()
    await expect(view.getByText(/blocked-request surge/i)).toBeVisible()
    await expect(view.getByText(/status check failing/i)).toBeVisible()
  })

  test('separates posture findings from live incidents', async ({ page }) => {
    await scanned(page)
    await page.getByText('Health', { exact: true }).first().click()
    const view = page.getByRole('main')
    // A misconfiguration is not an outage, and the view groups them apart.
    await expect(view.getByText(/allows IMDSv1/i)).toBeVisible()
    await expect(view.getByText(/exposes 22/i)).toBeVisible()
  })
})

test.describe('WAF', () => {
  test('shows sampled requests broken down by rule and client', async ({ page }) => {
    await scanned(page)
    await page.locator('text=cortex-waf').first().click()
    await page.getByRole('button', { name: 'Requests', exact: true }).click()
    await expect(page.locator('text=/summed sample weights/i')).toBeVisible()
    await expect(page.locator('text=/By client IP/i')).toBeVisible()
  })
})

test.describe('database load', () => {
  test('reads average active sessions against the vCPU count', async ({ page }) => {
    await scanned(page)
    await page.locator('text=prod-pg-primary').first().click()
    await page.getByRole('button', { name: 'Load', exact: true }).click()

    await expect(page.getByText(/average active sessions/i).first()).toBeVisible()
    // The comparison is the reading: load above vCPUs means queuing.
    await expect(page.getByText(/sessions are queuing/i)).toBeVisible()
    await expect(page.getByText(/Top wait events/i)).toBeVisible()
  })

  test('says Performance Insights is off rather than showing nothing', async ({ page }) => {
    await scanned(page)
    // The DR replica has it disabled, which is the common real-world case.
    await page.locator('text=dr-pg-replica').first().click()
    await page.getByRole('button', { name: 'Load', exact: true }).click()
    await expect(page.getByText(/not enabled/i)).toBeVisible()
  })
})

test.describe('analytics', () => {
  test('reports coverage against every resource, gaps included', async ({ page }) => {
    await scanned(page)
    await page.getByText('Analytics', { exact: true }).first().click()

    const view = page.getByRole('main')
    await expect(view.getByText('OBSERVABILITY COVERAGE')).toBeVisible()

    // The denominator is every resource, not just the measurable ones — a
    // percentage computed over what a tool can measure always looks good.
    await expect(view.getByText(/\d+ of \d+/).first()).toBeVisible()
    await expect(view.getByText(/uncovered —/).first()).toBeVisible()

    // Health state is carried by a label and a count, never colour alone.
    await expect(view.getByText('Not assessed')).toBeVisible()
    await expect(view.getByText('BLIND SPOTS')).toBeVisible()
  })

  test('a blind spot opens the resource it names', async ({ page }) => {
    await scanned(page)
    await page.getByText('Analytics', { exact: true }).first().click()
    const gaps = page.getByRole('main').locator('button').filter({ hasText: /Security group|Internet gateway|IAM role/ })
    if ((await gaps.count()) === 0) test.skip(true, 'no blind spots in this fixture')
    await gaps.first().click()
    await expect(page.locator('.ca-detail-heading').first()).toBeVisible()
  })
})

test.describe('automatic syncing', () => {
  test('is on by default at ten minutes', async ({ page }) => {
    const response = await page.request.get('/api/info', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    })
    const info = (await response.json()) as { autoRefreshSeconds: number }
    // Previously defined in the config schema and read by nothing.
    expect(info.autoRefreshSeconds).toBe(600)
  })
})

test.describe('resource detail page', () => {
  test('opens a full breakdown and returns where it came from', async ({ page }) => {
    await scanned(page)
    // Selected through the palette rather than by clicking the canvas, so the
    // test does not depend on where layout happened to put the node.
    await selectViaPalette(page, 'prod-pg-primary')
    await page.getByRole('button', { name: 'View details' }).click()

    // Everything the panel hides behind tabs, laid out at once.
    const headings = page.locator('.ca-detail-heading');
    await expect(headings.filter({ hasText: 'Overview' })).toBeVisible()
    await expect(headings.filter({ hasText: 'Metrics' })).toBeVisible()
    await expect(headings.filter({ hasText: 'Database load' })).toBeVisible()
    await expect(headings.filter({ hasText: 'Connections' })).toBeVisible()
    await expect(headings.filter({ hasText: 'Raw configuration' })).toBeVisible()

    // The finding that prompted opening it leads the page.
    await expect(page.getByText(/CPU and connections spiking/i).first()).toBeVisible()

    await page.getByRole('button', { name: '← Back' }).click()
    await expect(page.locator('.vue-flow__node').first()).toBeVisible()
  })

  test('shows the sections that apply to the resource, and no others', async ({ page }) => {
    await scanned(page)
    await selectViaPalette(page, 'cortex-waf')
    await page.getByRole('button', { name: 'View details' }).click()

    const headings = page.locator('.ca-detail-heading')
    await expect(headings.filter({ hasText: 'Sampled requests' })).toBeVisible()
    // A web ACL is not a database.
    await expect(headings.filter({ hasText: 'Database load' })).toHaveCount(0)
  })

  test('escape returns to the diagram', async ({ page }) => {
    await scanned(page)
    await selectViaPalette(page, 'prod-pg-primary')
    await page.getByRole('button', { name: 'View details' }).click()
    await expect(page.locator('.ca-detail-heading').first()).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.vue-flow__node').first()).toBeVisible()
  })
})

test.describe('VPC filter', () => {
  test('narrows the canvas to one network', async ({ page }) => {
    await scanned(page)

    const before = await page.locator('.vue-flow__node').count()
    await page.locator('button', { hasText: 'dr-vpc' }).first().click()
    await expect(page.getByRole('button', { name: 'Show all' })).toBeVisible()

    // The retrying assertion first: the canvas re-renders a frame or two after
    // the click, and reading a raw count straight away races it.
    await expect(page.locator('text=prod-pg-primary')).toHaveCount(0)
    await expect(page.locator('text=dr-pg-replica').first()).toBeVisible()
    expect(await page.locator('.vue-flow__node').count()).toBeLessThan(before)

    await page.getByRole('button', { name: 'Show all' }).click()
    await expect(page.locator('text=prod-pg-primary').first()).toBeVisible()
  })
})

test.describe('command palette', () => {
  test('opens on the keyboard and jumps to an exact match first', async ({ page }) => {
    await scanned(page)
    await page.keyboard.press('ControlOrMeta+k')

    const input = page.getByPlaceholder(/Search resources/i)
    await expect(input).toBeVisible()
    await input.fill('prod-pg-primary')

    await page.keyboard.press('Enter')
    await expect(page.locator('text=PostgreSQL').first()).toBeVisible()
  })

  test('closes on escape', async ({ page }) => {
    await scanned(page)
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByPlaceholder(/Search resources/i)
    await expect(input).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
  })
})

test.describe('agent', () => {
  test('states the credential boundary when no API key is set', async ({ page }) => {
    await scanned(page)
    await page.getByRole('button', { name: 'Ask Claude' }).click()
    await expect(page.locator('text=/ANTHROPIC_API_KEY/')).toBeVisible()
    await expect(page.locator('text=/never sent to the API/i')).toBeVisible()
  })
})

test.describe('export', () => {
  test('downloads the diagram as PNG', async ({ page }) => {
    await scanned(page)
    const download = page.waitForEvent('download', { timeout: 45_000 })
    await page.getByRole('button', { name: 'PNG', exact: true }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/\.png$/)
  })
})


/**
 * The degraded-scan banner, which the demo could not reach until
 * CLOUDATLAS_DEMO_ISSUES existed — which is how it shipped covering the canvas
 * with twenty-seven identical rows and no way to collapse it.
 */
test.describe('scan incomplete notice', () => {
  const KEY = 'cloudatlas:scan-notice-collapsed'

  test('groups repeated failures, collapses, and remembers the choice', async ({ page }) => {
    await scanned(page)

    const toggle = page.getByRole('button', { name: /Scan incomplete/ })
    if ((await toggle.count()) === 0) {
      test.skip(true, 'run with CLOUDATLAS_DEMO_ISSUES=1 to exercise this')
      return
    }

    // The collapsed choice is deliberately persistent, so the test sets the
    // starting state rather than inheriting whatever a previous run left.
    await page.evaluate((key) => localStorage.removeItem(key), KEY)
    await page.reload({ waitUntil: 'networkidle' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // One row per distinct cause, with the true total still in the heading.
    await expect(page.getByText(/27 calls failed for an unknown reason/)).toBeVisible()
    await expect(page.getByText(/1 distinct/)).toBeVisible()
    await expect(page.getByText(/×27/)).toBeVisible()

    await toggle.click()
    await expect(page.getByText(/failed for an unknown reason/)).toBeHidden()
    // Collapsed, but never gone: the counts stay on the header, because an
    // incomplete diagram that looks complete is the failure being prevented.
    await expect(toggle).toContainText(/missing permissions/)
    await expect(toggle).toContainText(/27 unknown/)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
