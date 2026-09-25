import {
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type GetQueryResultsCommandOutput,
  type ResultField,
  type StartQueryCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs'
import type { InsightsRequest, InsightsResponse } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * CloudWatch Logs Insights.
 *
 * Insights is asynchronous: `StartQuery` returns an id, and results arrive by
 * polling `GetQueryResults` until the status settles. Two things follow from
 * that which are easy to get wrong.
 *
 * First, a query that is still running has to be stopped. An abandoned query
 * keeps scanning — and keeps being billed for the bytes it scans — long after
 * whoever asked for it has closed the panel. Every exit from this function
 * either reaches a terminal status or calls `StopQuery`.
 *
 * Second, "we stopped waiting" and "AWS timed out" are different facts. Both
 * surface as a non-Complete status, and the error string says which one
 * happened rather than leaving the reader to guess.
 */

/** How long to wait before giving up and stopping the query. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Poll interval, growing so a slow query does not mean hundreds of calls. */
const POLL_START_MS = 300
const POLL_MAX_MS = 2_000

/**
 * `@ptr` is an opaque cursor Insights attaches to every row so it can be fed
 * back to `unmask`. It is a handle, not a value, and showing it as a column
 * pushes the real fields off the side of the table.
 */
const INTERNAL_FIELDS = new Set(['@ptr'])

type Terminal = 'Complete' | 'Failed' | 'Cancelled' | 'Timeout'

function isTerminal(status: string | undefined): status is Terminal {
  return status === 'Complete' || status === 'Failed' || status === 'Cancelled' || status === 'Timeout'
}

/**
 * Map the API's status onto the one the UI knows about.
 *
 * `Scheduled` means queued and is indistinguishable from running as far as the
 * caller is concerned. `Unknown` is reported as a failure rather than quietly
 * shown as a complete empty result.
 */
export function normalizeStatus(status: string | undefined): InsightsResponse['status'] {
  switch (status) {
    case 'Complete':
    case 'Running':
    case 'Failed':
    case 'Timeout':
    case 'Cancelled':
      return status
    case 'Scheduled':
      return 'Running'
    default:
      return 'Failed'
  }
}

/**
 * Column order comes from the rows, because Insights returns fields in the
 * order the query asked for them and gives no separate schema.
 */
export function columnsOf(rows: ResultField[][]): string[] {
  const seen = new Set<string>()
  const columns: string[] = []
  for (const row of rows) {
    for (const cell of row) {
      const field = cell.field
      if (!field || INTERNAL_FIELDS.has(field) || seen.has(field)) continue
      seen.add(field)
      columns.push(field)
    }
  }
  return columns
}

export function toRows(rows: ResultField[][]): Array<Record<string, string>> {
  return rows.map((row) => {
    const record: Record<string, string> = {}
    for (const cell of row) {
      if (!cell.field || INTERNAL_FIELDS.has(cell.field)) continue
      record[cell.field] = cell.value ?? ''
    }
    return record
  })
}

function buildResponse(
  output: GetQueryResultsCommandOutput,
  overrides: Partial<InsightsResponse> = {},
): InsightsResponse {
  const raw = output.results ?? []
  const statistics = output.statistics
  return {
    columns: columnsOf(raw),
    rows: toRows(raw),
    status: normalizeStatus(output.status),
    statistics: statistics
      ? {
          recordsMatched: statistics.recordsMatched ?? 0,
          recordsScanned: statistics.recordsScanned ?? 0,
          bytesScanned: statistics.bytesScanned ?? 0,
        }
      : null,
    error: null,
    ...overrides,
  }
}

export interface InsightsOptions {
  aws: AwsClient
  request: InsightsRequest
  /** Overridden in tests. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function queryInsights(options: InsightsOptions): Promise<InsightsResponse> {
  const { aws, request, signal } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = options.sleep ?? realSleep

  const started: StartQueryCommandOutput = await aws.send(
    'logs',
    request.region,
    'StartQuery',
    new StartQueryCommand({
      logGroupNames: request.logGroups,
      // Insights takes seconds, not milliseconds. Passing epoch ms here is the
      // classic way to get an empty result set from a query that is fine.
      startTime: Math.floor(request.start / 1000),
      endTime: Math.floor(request.end / 1000),
      queryString: request.query,
      limit: request.limit,
    }),
  )

  const queryId = started.queryId
  if (!queryId) {
    return {
      columns: [],
      rows: [],
      status: 'Failed',
      statistics: null,
      error: 'CloudWatch accepted the query but returned no query id.',
    }
  }

  const deadline = Date.now() + timeoutMs
  let wait = POLL_START_MS
  let last: GetQueryResultsCommandOutput | null = null

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) break

      const output: GetQueryResultsCommandOutput = await aws.send(
        'logs',
        request.region,
        'GetQueryResults',
        new GetQueryResultsCommand({ queryId }),
      )
      last = output

      if (isTerminal(output.status)) {
        return buildResponse(output, {
          error:
            output.status === 'Failed'
              ? 'CloudWatch reported the query as failed. Check the query syntax.'
              : output.status === 'Timeout'
                ? 'CloudWatch timed out running this query. Narrow the time range or the log groups.'
                : null,
        })
      }

      await sleep(wait)
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.6))
    }
  } finally {
    // Whether we timed out, were aborted, or threw, the query must not be left
    // running: it keeps scanning and keeps billing.
    if (!isTerminal(last?.status)) await stopQuietly(aws, request.region, queryId)
  }

  const abandoned = signal?.aborted === true
  const partial = last ? buildResponse(last) : null
  return {
    columns: partial?.columns ?? [],
    rows: partial?.rows ?? [],
    // Not 'Cancelled', which would suggest CloudWatch cancelled it.
    status: 'Timeout',
    statistics: partial?.statistics ?? null,
    error: abandoned
      ? 'The request was cancelled, so CloudAtlas stopped the query.'
      : `CloudAtlas stopped the query after ${Math.round(timeoutMs / 1000)}s. ` +
        'Any rows below are partial results. Narrow the time range or add a more selective filter.',
  }
}

/**
 * Stopping is best-effort by nature: the query may have finished in the
 * meantime, which AWS reports as an error. That is not worth surfacing over the
 * results the caller actually asked for.
 */
async function stopQuietly(aws: AwsClient, region: string, queryId: string): Promise<void> {
  try {
    await aws.send('logs', region, 'StopQuery', new StopQueryCommand({ queryId }))
  } catch {
    // Already finished, already stopped, or denied — none of which changes the
    // answer we are about to return.
  }
}
