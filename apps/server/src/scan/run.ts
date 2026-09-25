import pLimit from 'p-limit'
import {
  INTERNET_NODE_ID,
  type Alarm,
  type CollectorFailure,
  type Finding,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type MissingPermission,
  type ScanProgress,
  type SecurityGroup,
} from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { scanGlobal, scanRegion, type GlobalScanData, type RegionScanData } from '../collectors/index.js'
import { buildRegionGraph } from '../graph/build.js'
import {
  buildGlobalGraph,
  buildServiceEdges,
  buildWafEdges,
  referencedRoles,
} from '../graph/services.js'
import { analyzeSecurityGroups } from '../graph/sg-risk.js'
import { applyHealth, detectPosture } from '../health/index.js'
import { applyCosts, fetchServiceCosts } from '../cost/explorer.js'

export interface RunScanOptions {
  aws: AwsClient
  /** Cost Explorer is billed per request, so it only runs when asked for. */
  enableCostExplorer?: boolean
  profile: string
  accountId: string
  accountAlias: string | null
  regions: string[]
  /** Regions scanned at once. The spec's target is 4. */
  concurrency?: number
  onProgress?: (progress: ScanProgress) => void
  onWarning?: (warning: MissingPermission) => void
  /** Called for each call that failed in a way no classifier recognised. */
  onFailure?: (failure: CollectorFailure) => void
  signal?: AbortSignal
}

export interface ScanResult {
  graph: Graph
  alarms: Alarm[]
  /** Posture findings derived during the scan (risky SG rules today). */
  findings: Finding[]
  /** Raw per-region data, kept so the capture tool can report on it. */
  perRegion: RegionScanData[]
  /** Account-wide data, collected once. */
  global: GlobalScanData
}

/** The synthetic node risky-rule edges point at. */
function internetNode(): GraphNode {
  return {
    id: INTERNET_NODE_ID,
    arn: null,
    type: 'internet',
    category: 'security',
    name: '0.0.0.0/0',
    abbr: 'WWW',
    subtitle: 'internet',
    typeLabel: 'Public internet',
    region: 'global',
    az: null,
    vpcId: null,
    subnetId: null,
    parentId: null,
    state: '—',
    tags: [],
    props: [
      { k: 'CIDR', v: '0.0.0.0/0', mono: true },
      { k: 'Description', v: 'Synthetic node for world-open security group rules', mono: false },
    ],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
  }
}

/**
 * Scan every requested region and assemble one graph.
 *
 * Regions run concurrently; within a region the collectors run in order because
 * later ones place their resources relative to the VPC topology the first one
 * fetched.
 */
export async function runScan(options: RunScanOptions): Promise<ScanResult> {
  const { aws, profile, accountId, accountAlias, regions, onProgress, onWarning, onFailure, signal } =
    options
  const limit = pLimit(options.concurrency ?? 4)

  for (const region of regions) {
    onProgress?.({
      region,
      state: 'queued',
      progress: 0,
      step: null,
      resourceCount: 0,
      error: null,
    })
  }

  // The global pass runs concurrently with the regions rather than before them:
  // nothing in a region depends on it, and serialising would add its latency to
  // every scan for no ordering benefit.
  const globalPromise = scanGlobal({
    context: {
      aws,
      accountId,
      onWarning: (warning) => onWarning?.(warning),
      onFailure: (failure) => onFailure?.(failure),
    },
    ...(signal ? { signal } : {}),
  }).catch((error) => {
    // One failed global collector must not lose the regions.
    onProgress?.({
      region: 'global',
      state: 'error',
      progress: 1,
      step: null,
      resourceCount: 0,
      error: (error as Error).message,
    })
    return null
  })

  const perRegion = await Promise.all(
    regions.map((region) =>
      limit(async (): Promise<RegionScanData> => {
        try {
          return await scanRegion({
            context: {
              aws,
              region,
              accountId,
              onWarning: (warning) => onWarning?.(warning),
              onFailure: (failure) => onFailure?.(failure),
            },
            signal,
            onProgress: (progress, step) =>
              onProgress?.({
                region,
                state: 'scanning',
                progress,
                step,
                resourceCount: 0,
                error: null,
              }),
          })
        } catch (error) {
          onProgress?.({
            region,
            state: 'error',
            progress: 1,
            step: null,
            resourceCount: 0,
            error: (error as Error).message,
          })
          // One bad region must not lose the others.
          const { emptyRegionScanData } = await import('../collectors/types.js')
          return emptyRegionScanData(region)
        }
      }),
    ),
  )

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const securityGroups: SecurityGroup[] = []
  const alarms: Alarm[] = []
  const missingPermissions: MissingPermission[] = []
  const collectorFailures: CollectorFailure[] = []
  const regionCounts: Array<{ id: string; count: number }> = []

  const { emptyGlobalScanData } = await import('../collectors/types.js')
  const globalData = (await globalPromise) ?? emptyGlobalScanData()

  for (const [index, data] of perRegion.entries()) {
    const built = buildRegionGraph(data, accountId, globalData)
    nodes.push(...built.nodes)
    edges.push(...built.edges)
    securityGroups.push(...built.securityGroups)
    alarms.push(...built.alarms)
    missingPermissions.push(...data.warnings)
    collectorFailures.push(...data.failures)
    regionCounts.push({ id: data.region, count: built.resourceCount })

    const region = regions[index]
    if (region) {
      onProgress?.({
        region,
        state: 'done',
        progress: 1,
        step: null,
        resourceCount: built.resourceCount,
        error: null,
      })
    }
  }

  // Global services are built after the regions so role filtering can see what
  // every region actually referenced.
  const roleArns = new Set(perRegion.flatMap(referencedRoles))
  const builtGlobal = buildGlobalGraph(globalData, roleArns)
  nodes.push(...builtGlobal.nodes)
  edges.push(...builtGlobal.edges)
  missingPermissions.push(...globalData.warnings)
  collectorFailures.push(...globalData.failures)

  // Name-resolved edges need every node in place, so they come last.
  edges.push(...buildServiceEdges(nodes, perRegion, globalData))
  edges.push(...buildWafEdges(nodes, perRegion, globalData))

  // Security analysis runs once over the whole estate so an SG referenced from
  // another region still resolves.
  const now = Date.now()
  const analysis = analyzeSecurityGroups(securityGroups, nodes, now)
  const allEdges = [...edges, ...analysis.sgEdges, ...analysis.riskEdges]
  if (analysis.riskEdges.length > 0) nodes.push(internetNode())

  if (options.enableCostExplorer) {
    const costs = await fetchServiceCosts({
      aws,
      onWarning: (action) => onWarning?.({ action, region: 'global', section: 'cost', message: 'Cost Explorer denied' }),
    })
    applyCosts(nodes, costs)
  }

  // Posture detectors read the graph, so they work identically here, against a
  // replayed fixture, and against the demo provider.
  const findings = [...analysis.findings, ...detectPosture(nodes, now)]
  applyHealth(nodes, findings)

  const graph: Graph = {
    nodes,
    edges: allEdges,
    securityGroups: analysis.securityGroups,
    regions: regionCounts,
    missingPermissions,
    collectorFailures,
    scannedAt: now,
    accountId,
    accountAlias,
    profile,
  }

  return { graph, alarms, findings, perRegion, global: globalData }
}
