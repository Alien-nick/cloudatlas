import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
  type GetCostForecastCommandOutput,
  type ResultByTime,
} from '@aws-sdk/client-cost-explorer'
import type { ActualSpend } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Actual spend, from Cost Explorer.
 *
 * Cost Explorer bills $0.01 per request, so this is built around not asking:
 *
 *   - Nothing is requested until the user turns it on (a setting kept in the
 *     local data directory, or `enableCostExplorer` in the config file).
 *   - One refresh is four requests, and the result is cached on disk for
 *     twelve hours — the data itself only updates a few times a day.
 *   - A manual refresh inside ten minutes of the last one returns the cache.
 *
 * At most that is a few cents a day, and usually less.
 */

const HOUR = 60 * 60 * 1000
export const CACHE_TTL_MS = 12 * HOUR
export const MIN_REFRESH_MS = 10 * 60 * 1000

export function emptySpend(status: ActualSpend['status'], message: string | null): ActualSpend {
  return {
    status,
    message,
    currency: 'USD',
    fetchedAt: null,
    monthToDate: null,
    lastMonth: null,
    forecastMonthEnd: null,
    byService: [],
    byRegion: [],
    daily: [],
  }
}

const day = (date: Date): string => date.toISOString().slice(0, 10)

export function spendWindows(now: Date): {
  monthStart: string
  lastMonthStart: string
  nextMonthStart: string
  tomorrow: string
  thirtyDaysAgo: string
} {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return {
    monthStart: day(new Date(Date.UTC(y, m, 1))),
    lastMonthStart: day(new Date(Date.UTC(y, m - 1, 1))),
    nextMonthStart: day(new Date(Date.UTC(y, m + 1, 1))),
    // Cost Explorer's end date is exclusive, so "through today" ends tomorrow.
    tomorrow: day(new Date(now.getTime() + 24 * HOUR)),
    thirtyDaysAgo: day(new Date(now.getTime() - 30 * 24 * HOUR)),
  }
}

const amountOf = (metric: { Amount?: string } | undefined): number => {
  const value = Number(metric?.Amount ?? '0')
  return Number.isFinite(value) ? value : 0
}

/** Sum grouped results per key, for the periods a predicate selects. */
export function sumGroups(results: ResultByTime[], include: (start: string) => boolean): Map<string, number> {
  const totals = new Map<string, number>()
  for (const period of results) {
    if (!include(period.TimePeriod?.Start ?? '')) continue
    for (const group of period.Groups ?? []) {
      const key = group.Keys?.[0]
      if (key) totals.set(key, (totals.get(key) ?? 0) + amountOf(group.Metrics?.UnblendedCost))
    }
  }
  return totals
}

async function costAndUsage(aws: AwsClient, input: GetCostAndUsageCommandInput): Promise<ResultByTime[]> {
  const results: ResultByTime[] = []
  let token: string | undefined
  // Each page is billed too; five is far more than an account's service list needs.
  for (let page = 0; page < 5; page++) {
    const output = await aws.send<GetCostAndUsageCommandOutput>(
      'ce',
      'us-east-1',
      'GetCostAndUsage',
      new GetCostAndUsageCommand({ ...input, NextPageToken: token }),
    )
    results.push(...(output.ResultsByTime ?? []))
    token = output.NextPageToken
    if (!token) break
  }
  return results
}

const rounded = (value: number): number => Math.round(value * 100) / 100

export async function fetchActualSpend(aws: AwsClient, now = new Date()): Promise<ActualSpend> {
  const w = spendWindows(now)
  const metric = { Metrics: ['UnblendedCost'] }

  try {
    const byServiceResults = await costAndUsage(aws, {
      TimePeriod: { Start: w.lastMonthStart, End: w.tomorrow },
      Granularity: 'MONTHLY',
      ...metric,
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    })
    const thisMonth = sumGroups(byServiceResults, (start) => start >= w.monthStart)
    const lastMonth = sumGroups(byServiceResults, (start) => start < w.monthStart)

    const dailyResults = await costAndUsage(aws, {
      TimePeriod: { Start: w.thirtyDaysAgo, End: w.tomorrow },
      Granularity: 'DAILY',
      ...metric,
    })
    const byRegion = sumGroups(
      await costAndUsage(aws, {
        TimePeriod: { Start: w.monthStart, End: w.tomorrow },
        Granularity: 'MONTHLY',
        ...metric,
        GroupBy: [{ Type: 'DIMENSION', Key: 'REGION' }],
      }),
      () => true,
    )

    const monthToDate = [...thisMonth.values()].reduce((sum, value) => sum + value, 0)
    let forecastMonthEnd: number | null = null
    // The forecast needs a window that has not happened yet; on the last day
    // of the month there is none, and month to date is the answer.
    if (w.tomorrow < w.nextMonthStart) {
      try {
        const forecast = await aws.send<GetCostForecastCommandOutput>(
          'ce',
          'us-east-1',
          'GetCostForecast',
          new GetCostForecastCommand({
            TimePeriod: { Start: w.tomorrow, End: w.nextMonthStart },
            Metric: 'UNBLENDED_COST',
            Granularity: 'MONTHLY',
          }),
        )
        forecastMonthEnd = rounded(monthToDate + amountOf(forecast.Total))
      } catch {
        // New accounts have too little history to forecast; that is not an error worth showing.
        forecastMonthEnd = null
      }
    } else {
      forecastMonthEnd = rounded(monthToDate)
    }

    const services = new Set([...thisMonth.keys(), ...lastMonth.keys()])
    return {
      status: 'ok',
      message: null,
      currency: byServiceResults[0]?.Total?.UnblendedCost?.Unit ?? 'USD',
      fetchedAt: now.getTime(),
      monthToDate: rounded(monthToDate),
      lastMonth: rounded([...lastMonth.values()].reduce((sum, value) => sum + value, 0)),
      forecastMonthEnd,
      byService: [...services]
        .map((key) => ({ key, monthToDate: rounded(thisMonth.get(key) ?? 0), lastMonth: rounded(lastMonth.get(key) ?? 0) }))
        .filter((entry) => entry.monthToDate > 0.004 || entry.lastMonth > 0.004)
        .sort((a, b) => b.monthToDate - a.monthToDate || b.lastMonth - a.lastMonth),
      byRegion: [...byRegion]
        .map(([key, amount]) => ({ key, amount: rounded(amount) }))
        .filter((entry) => entry.amount > 0.004)
        .sort((a, b) => b.amount - a.amount),
      daily: dailyResults.map((period) => ({
        key: period.TimePeriod?.Start ?? '',
        amount: rounded(amountOf(period.Total?.UnblendedCost)),
      })),
    }
  } catch (error) {
    const err = error as Error & { name: string }
    if (err.name === 'AccessDeniedException') {
      return emptySpend('denied', 'The profile lacks ce:GetCostAndUsage. Add it to its policy to see actual spend.')
    }
    return emptySpend('error', `Cost Explorer could not be read (${err.name}).`)
  }
}

// ---------------------------------------------------------------------------
// Settings and cache, both in the local data directory
// ---------------------------------------------------------------------------

interface CostState {
  costExplorerEnabled?: boolean
  /** Keyed by profile. */
  spend?: Record<string, ActualSpend>
}

function statePath(dataDir: string): string {
  return join(dataDir, 'cost.json')
}

export function readCostState(dataDir: string): CostState {
  try {
    return JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as CostState
  } catch {
    return {}
  }
}

export function writeCostState(dataDir: string, state: CostState): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2))
}

export interface SpendOptions {
  aws: AwsClient
  profile: string
  dataDir: string
  /** From the config file; the in-app setting can also turn it on. */
  enabledByConfig: boolean
  refresh?: boolean
  now?: Date
  fetch?: typeof fetchActualSpend
}

/** Cached spend for the profile, fetching only when enabled and stale. */
export async function getActualSpend(options: SpendOptions): Promise<ActualSpend> {
  const now = options.now ?? new Date()
  const state = readCostState(options.dataDir)
  const enabled = options.enabledByConfig || state.costExplorerEnabled === true
  if (!enabled) {
    return emptySpend(
      'disabled',
      'Cost Explorer is off. Turning it on costs about $0.04 per refresh, cached for 12 hours.',
    )
  }

  const cached = state.spend?.[options.profile]
  const age = cached?.fetchedAt ? now.getTime() - cached.fetchedAt : Number.POSITIVE_INFINITY
  const fresh = age < CACHE_TTL_MS && !options.refresh
  const tooSoon = options.refresh && age < MIN_REFRESH_MS
  if (cached && cached.status === 'ok' && (fresh || tooSoon)) return cached

  const spend = await (options.fetch ?? fetchActualSpend)(options.aws, now)
  // Failures are not cached: the next request should try again.
  if (spend.status === 'ok') {
    writeCostState(options.dataDir, { ...state, spend: { ...state.spend, [options.profile]: spend } })
  }
  return spend
}

export function setCostExplorerEnabled(dataDir: string, enabled: boolean): void {
  writeCostState(dataDir, { ...readCostState(dataDir), costExplorerEnabled: enabled })
}
