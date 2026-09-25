import {
  DescribeDimensionKeysCommand,
  GetResourceMetricsCommand,
  type DescribeDimensionKeysResponse,
  type GetResourceMetricsResponse,
} from '@aws-sdk/client-pi'
import type { DatabaseLoad, DbLoadItem, GraphNode } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Performance Insights: what a database was actually busy with.
 *
 * This is the answer the connection-spike finding cannot give on its own. It
 * reports that connections are at 89% of max_connections; this says *which*
 * statements and which wait events are holding them.
 *
 * Two things make Performance Insights easy to call wrongly, and both fail
 * quietly rather than loudly:
 *
 *  1. The `Identifier` is the instance's **DbiResourceId** — an opaque
 *     `db-XXXXXXXXXXXXXXXX` — not the DB instance identifier you see
 *     everywhere else. Passing the familiar name returns an error about an
 *     unknown resource that reads like the instance does not exist.
 *  2. Performance Insights has to be enabled, and its retention window is
 *     configurable and often short. Asking outside it returns an empty
 *     response, not an error — indistinguishable from an idle database.
 *
 * So both preconditions are checked from data the scan already has, and an
 * unavailable result says which one failed.
 */

/** Items below this share of total load are noise in a top-N list. */
const MIN_SHARE = 0.01

/** Statement text is truncated: a single query can be kilobytes. */
const MAX_LABEL = 400

export function dbiResourceIdOf(node: GraphNode): string | null {
  const raw = node.raw as { DbiResourceId?: string } | null
  const id = raw?.DbiResourceId
  return typeof id === 'string' && id.startsWith('db-') ? id : null
}

export function performanceInsightsEnabled(node: GraphNode): boolean {
  return node.props.some(
    (prop) => prop.k === 'Performance Insights' && prop.v.startsWith('enabled'),
  )
}

/** vCPU count, parsed from the instance-class prop when it states one. */
export function vcpusOf(node: GraphNode): number | null {
  const value = node.props.find((prop) => prop.k === 'Instance class')?.v
  const match = value ? /(\d+)\s*vCPU/i.exec(value) : null
  return match?.[1] ? Number.parseInt(match[1], 10) : null
}

function toItems(
  response: DescribeDimensionKeysResponse,
  dimension: string,
): DbLoadItem[] {
  const total = response.Keys?.reduce((sum, key) => sum + (key.Total ?? 0), 0) ?? 0
  if (total <= 0) return []

  return (response.Keys ?? [])
    .map((key) => {
      const label = key.Dimensions?.[dimension] ?? '(unknown)'
      const load = key.Total ?? 0
      return {
        label: label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label,
        load: Math.round(load * 100) / 100,
        share: load / total,
      }
    })
    .filter((item) => item.share >= MIN_SHARE)
    .sort((a, b) => b.load - a.load)
    .slice(0, 10)
}

function unavailable(nodeId: string, reason: string): DatabaseLoad {
  return {
    nodeId,
    averageLoad: null,
    vcpus: null,
    topSql: [],
    topWaits: [],
    unavailableReason: reason,
  }
}

export interface DatabaseLoadOptions {
  aws: AwsClient
  node: GraphNode
  start: number
  end: number
}

export async function getDatabaseLoad(options: DatabaseLoadOptions): Promise<DatabaseLoad> {
  const { aws, node, start, end } = options

  if (node.type !== 'rds') {
    return unavailable(node.id, 'Performance Insights is only available for RDS instances.')
  }
  if (!performanceInsightsEnabled(node)) {
    return unavailable(
      node.id,
      `Performance Insights is not enabled on ${node.name}. Enable it on the instance to see which statements and wait events are driving load.`,
    )
  }
  const identifier = dbiResourceIdOf(node)
  if (!identifier) {
    // Recorded rather than guessed: the DB instance identifier is not a valid
    // substitute, and sending it would produce a confusing "no such resource".
    return unavailable(
      node.id,
      'The scan did not record this instance’s DbiResourceId, which Performance Insights requires. Re-scan to pick it up.',
    )
  }

  const window = { StartTime: new Date(start), EndTime: new Date(end) }
  const common = { ServiceType: 'RDS' as const, Identifier: identifier }

  try {
    const [load, sql, waits] = await Promise.all([
      aws.send<GetResourceMetricsResponse>(
        'pi',
        node.region,
        'GetResourceMetrics',
        new GetResourceMetricsCommand({
          ...common,
          ...window,
          MetricQueries: [{ Metric: 'db.load.avg' }],
          PeriodInSeconds: 60,
        }),
      ),
      aws.send<DescribeDimensionKeysResponse>(
        'pi',
        node.region,
        'DescribeDimensionKeys',
        new DescribeDimensionKeysCommand({
          ...common,
          ...window,
          Metric: 'db.load.avg',
          GroupBy: { Group: 'db.sql_tokenized', Limit: 10 },
        }),
      ),
      aws.send<DescribeDimensionKeysResponse>(
        'pi',
        node.region,
        'DescribeDimensionKeys',
        new DescribeDimensionKeysCommand({
          ...common,
          ...window,
          Metric: 'db.load.avg',
          GroupBy: { Group: 'db.wait_event', Limit: 10 },
        }),
      ),
    ])

    const points = (load.MetricList?.[0]?.DataPoints ?? [])
      .map((point) => point.Value)
      .filter((value): value is number => typeof value === 'number')
    const averageLoad =
      points.length > 0
        ? Math.round((points.reduce((sum, value) => sum + value, 0) / points.length) * 100) / 100
        : null

    const result: DatabaseLoad = {
      nodeId: node.id,
      averageLoad,
      vcpus: vcpusOf(node),
      topSql: toItems(sql, 'db.sql_tokenized.statement'),
      topWaits: toItems(waits, 'db.wait_event.name'),
      unavailableReason: null,
    }

    // An empty response inside a window PI should cover usually means the
    // window predates its retention, which is configurable and often 7 days.
    if (averageLoad === null && result.topSql.length === 0 && result.topWaits.length === 0) {
      return {
        ...result,
        unavailableReason:
          'Performance Insights returned no data for this window. It may be outside the configured retention period, or the instance may have been idle.',
      }
    }
    return result
  } catch (error) {
    const err = error as Error & { action?: string }
    if (err.name === 'AccessDeniedException') {
      return unavailable(node.id, `Missing permission: ${err.action ?? 'pi:DescribeDimensionKeys'}.`)
    }
    return unavailable(node.id, `Performance Insights call failed: ${err.message}`)
  }
}
