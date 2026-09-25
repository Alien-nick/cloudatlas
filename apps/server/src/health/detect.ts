import {
  choosePeriod,
  primaryMetricsFor,
  type Finding,
  type Graph,
  type GraphNode,
  type DetectionConfig,
  type MetricSeries,
} from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { fetchMetricsForNodes, type MetricTarget } from '../metrics/batch.js'
import { fetchMaxConnections } from '../metrics/parameters.js'
import { detectSpikes, type ResourceLimits, type SpikeInput } from './spike.js'

/**
 * One health pass over a scanned graph.
 *
 * Kept separate from the topology scan on purpose. The scan is slow, expensive
 * and mostly static; health is cheap, repeated on a timer, and only meaningful
 * against fresh data. Folding the two together would either make every scan
 * drag in hundreds of CloudWatch calls or make health as stale as the last
 * scan.
 */

/** How much history the baseline is computed over. */
export const BASELINE_WINDOW_MS = 3 * 60 * 60 * 1000

export interface HealthPassOptions {
  aws: AwsClient
  graph: Graph
  now?: number
  /** From cloudatlas.config.json. Without this the block is dead config. */
  detection?: DetectionConfig
  /** Overridden in tests; defaults to the 3-hour baseline window. */
  windowMs?: number
}

export interface HealthPassResult {
  findings: Finding[]
  /** Series fetched during the pass, so the UI can chart what was judged. */
  series: MetricSeries[]
  evaluatedAt: number
  missingPermissions: string[]
}

/** Nodes worth polling: those the catalog has primary metrics for. */
export function healthTargets(nodes: GraphNode[]): MetricTarget[] {
  const targets: MetricTarget[] = []
  for (const node of nodes) {
    const defs = primaryMetricsFor(node.type)
    if (defs.length === 0) continue
    targets.push({ node, defs })
  }
  return targets
}

/**
 * Resolve the denominators the detector needs.
 *
 * Only for databases that actually publish DatabaseConnections, so a scan of an
 * account with no RDS makes no parameter-group calls at all. Failures are
 * recorded as a reason, not thrown: an unreadable parameter group costs one
 * evidence line, and must not cost the finding.
 */
export async function resolveLimits(
  aws: AwsClient,
  nodes: GraphNode[],
): Promise<Map<string, ResourceLimits>> {
  const limits = new Map<string, ResourceLimits>()

  for (const node of nodes) {
    if (node.type !== 'rds') continue
    const raw = node.raw as { DBParameterGroups?: Array<{ DBParameterGroupName?: string }> }
    const groupName = raw?.DBParameterGroups?.[0]?.DBParameterGroupName
    if (!groupName) {
      limits.set(node.id, {
        maxConnectionsUnknown: 'no parameter group was reported for this instance',
      })
      continue
    }
    limits.set(
      node.id,
      await fetchMaxConnections({ aws, region: node.region, parameterGroupName: groupName }),
    )
  }

  return limits
}

export async function runHealthPass(options: HealthPassOptions): Promise<HealthPassResult> {
  const { aws, graph } = options
  const now = options.now ?? Date.now()
  // `detection.baselineMinutes` sets how much history the baseline covers.
  const baselineMs = options.detection?.baselineMinutes
    ? options.detection.baselineMinutes * 60_000
    : (options.windowMs ?? BASELINE_WINDOW_MS)
  const start = now - baselineMs

  const targets = healthTargets(graph.nodes)
  if (targets.length === 0) {
    return { findings: [], series: [], evaluatedAt: now, missingPermissions: [] }
  }

  const period = choosePeriod(start, now)
  const series = await fetchMetricsForNodes({ aws, targets, period, start, end: now })

  const limits = await resolveLimits(
    aws,
    targets.map((target) => target.node),
  )

  const byNode = new Map<string, MetricSeries[]>()
  for (const entry of series) {
    const list = byNode.get(entry.nodeId) ?? []
    list.push(entry)
    byNode.set(entry.nodeId, list)
  }

  const inputs: SpikeInput[] = targets.map((target) => ({
    node: target.node,
    series: byNode.get(target.node.id) ?? [],
  }))

  return {
    findings: detectSpikes(inputs, {
      now,
      limits,
      ...(options.detection?.zScoreThreshold !== undefined
        ? { zThreshold: options.detection.zScoreThreshold }
        : {}),
      ...(options.detection?.floors ? { floors: options.detection.floors } : {}),
    }),
    series,
    evaluatedAt: now,
    missingPermissions: [...aws.stats.accessDenied],
  }
}
