import {
  GetMetricDataCommand,
  type GetMetricDataOutput,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch'
import type { GraphNode, MetricDef, MetricSeries } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { describeDimensions, queriesFor, noQueryReason } from './dimensions.js'
import { emptySeriesReason, unavailableReason } from './availability.js'

/** CloudWatch accepts at most 500 MetricDataQuery entries per call. */
export const MAX_QUERIES_PER_CALL = 500

/** One series we intend to fetch, before it has any data. */
interface PlannedSeries {
  id: string
  node: GraphNode
  def: MetricDef
  dimensions: string
  label: string
  query: MetricDataQuery
}

/**
 * Build the timestamp grid the series will be reported on.
 *
 * CloudWatch returns only the timestamps that have data, so a gap is invisible
 * in the response — the points either side simply sit next to each other. The
 * grid restores it: every slot that received no datapoint stays null, and the
 * chart draws a break instead of interpolating across an outage. Zero-filling
 * here would turn "the instance was unreachable" into "load dropped to zero",
 * which is the opposite conclusion.
 */
export function timestampGrid(startMs: number, endMs: number, periodSec: number): number[] {
  const step = periodSec * 1000
  // CloudWatch aligns each datapoint to the start of its period.
  const first = Math.floor(startMs / step) * step
  const grid: number[] = []
  for (let t = first; t < endMs; t += step) grid.push(t)
  return grid
}

/** Split into calls of at most `size` queries. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * A percentile stat goes straight into `Stat`; the named statistics do too.
 * Kept as a function so the one place that needs to know stays findable.
 */
function statFor(def: MetricDef): string {
  return def.stat
}

export interface MetricTarget {
  node: GraphNode
  defs: MetricDef[]
}

export interface PlanOptions {
  node: GraphNode
  defs: MetricDef[]
  period: number
}

export interface PlanAllOptions {
  targets: MetricTarget[]
  period: number
}

export interface MetricPlan {
  /** Series to fetch, in query order. */
  planned: PlannedSeries[]
  /** Series we deliberately did not query, with the reason shown to the user. */
  skipped: MetricSeries[]
}

function emptySeries(
  node: GraphNode,
  def: MetricDef,
  period: number,
  label: string,
  reason: string,
): MetricSeries {
  return {
    nodeId: node.id,
    metricName: def.name,
    namespace: def.namespace,
    label,
    unit: def.unit,
    stat: def.stat,
    timestamps: [],
    values: [],
    period,
    unavailableReason: reason,
  }
}

/**
 * Decide what to ask CloudWatch for.
 *
 * Separated from the fetch so the decision is testable without a client, and
 * so every series the caller asked for appears in the result — either with data
 * or with a reason. A metric silently dropped from the plan would show up in
 * the UI as a missing chart, which reads as a bug rather than as information.
 */
export function planMetrics(options: PlanOptions): MetricPlan {
  return planAll({ targets: [{ node: options.node, defs: options.defs }], period: options.period })
}

/**
 * Plan across many nodes at once.
 *
 * Query ids are assigned over the whole batch rather than per node, because
 * CloudWatch requires them unique within a call and the health pass packs
 * several hundred nodes into one. Ids are opaque — the mapping back to a series
 * is held in `planned`, never re-derived from the id.
 */
export function planAll(options: PlanAllOptions): MetricPlan {
  const { targets, period } = options
  const planned: PlannedSeries[] = []
  const skipped: MetricSeries[] = []

  for (const { node, defs } of targets) {
    for (const def of defs) {
      const blocked = unavailableReason(node, def)
      if (blocked) {
        skipped.push(emptySeries(node, def, period, def.label, blocked))
        continue
      }

      const queries = queriesFor(node, def)
      if (queries.length === 0) {
        skipped.push(emptySeries(node, def, period, def.label, noQueryReason(node, def)))
        continue
      }

      for (const query of queries) {
        const id = `m${planned.length}`
        const label = query.labelSuffix ? `${def.label} · ${query.labelSuffix}` : def.label
        planned.push({
          id,
          node,
          def,
          label,
          dimensions: describeDimensions(query.dimensions),
          query: {
            Id: id,
            // Returned labels are ignored in favour of our own, but setting it
            // makes a raw response readable when debugging a capture.
            Label: label,
            ReturnData: true,
            MetricStat: {
              Metric: {
                Namespace: def.namespace,
                MetricName: def.name,
                Dimensions: query.dimensions,
              },
              Period: period,
              Stat: statFor(def),
            },
          },
        })
      }
    }
  }

  return { planned, skipped }
}

export interface FetchOptions extends PlanOptions {
  aws: AwsClient
  region: string
  start: number
  end: number
}

export interface FetchAllOptions {
  aws: AwsClient
  targets: MetricTarget[]
  period: number
  start: number
  end: number
}

/** One node's series. Thin wrapper over the multi-node path. */
export async function fetchMetrics(options: FetchOptions): Promise<MetricSeries[]> {
  const { aws, period, start, end } = options
  return fetchMetricsForNodes({
    aws,
    targets: [{ node: options.node, defs: options.defs }],
    period,
    start,
    end,
  })
}

/**
 * Run a plan against CloudWatch and return one series per planned entry.
 *
 * Calls are grouped by region, since GetMetricData only sees metrics in the
 * region it is sent to. Within a region the queries are packed to the 500-query
 * limit: a health pass over a large account is a few calls, not one per node.
 *
 * Pagination note: with a NextToken, CloudWatch continues the *same* query ids
 * across pages rather than starting new ones, so datapoints for `m3` can arrive
 * in two separate responses. They are merged into the grid by timestamp, which
 * makes page order irrelevant.
 */
export async function fetchMetricsForNodes(options: FetchAllOptions): Promise<MetricSeries[]> {
  const { aws, targets, period, start, end } = options
  const { planned, skipped } = planAll({ targets, period })
  if (planned.length === 0) return skipped

  const grid = timestampGrid(start, end, period)
  const indexByTimestamp = new Map(grid.map((t, i) => [t, i]))
  const valuesById = new Map<string, Array<number | null>>(
    planned.map((entry) => [entry.id, grid.map(() => null)]),
  )

  const byRegion = new Map<string, PlannedSeries[]>()
  for (const entry of planned) {
    const list = byRegion.get(entry.node.region) ?? []
    list.push(entry)
    byRegion.set(entry.node.region, list)
  }

  for (const [region, entries] of byRegion) {
    for (const batch of chunk(entries, MAX_QUERIES_PER_CALL)) {
      let token: string | undefined
      do {
        const output: GetMetricDataOutput = await aws.send(
          'cloudwatch',
          region,
          'GetMetricData',
          new GetMetricDataCommand({
            MetricDataQueries: batch.map((entry) => entry.query),
            StartTime: new Date(start),
            EndTime: new Date(end),
            ScanBy: 'TimestampAscending',
            NextToken: token,
          }),
        )

        for (const result of output.MetricDataResults ?? []) {
          const values = result.Id ? valuesById.get(result.Id) : undefined
          if (!values) continue
          const timestamps = result.Timestamps ?? []
          const points = result.Values ?? []
          for (const [i, timestamp] of timestamps.entries()) {
            const slot = indexByTimestamp.get(alignTo(timestamp.getTime(), period))
            const value = points[i]
            if (slot === undefined || value === undefined) continue
            values[slot] = value
          }
        }

        token = output.NextToken
      } while (token)
    }
  }

  const fetched = planned.map((entry): MetricSeries => {
    const values = valuesById.get(entry.id) ?? []
    const hasData = values.some((value) => value !== null)
    return {
      nodeId: entry.node.id,
      metricName: entry.def.name,
      namespace: entry.def.namespace,
      label: entry.label,
      unit: entry.def.unit,
      stat: entry.def.stat,
      timestamps: hasData ? grid : [],
      values: hasData ? values : [],
      period,
      unavailableReason: hasData ? null : emptySeriesReason(entry.def, entry.dimensions),
    }
  })

  return [...fetched, ...skipped]
}

function alignTo(timestampMs: number, periodSec: number): number {
  const step = periodSec * 1000
  return Math.floor(timestampMs / step) * step
}
