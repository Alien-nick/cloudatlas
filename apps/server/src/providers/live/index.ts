import { randomUUID } from 'node:crypto'
import type {
  Alarm,
  DatabaseLoad,
  DetectionConfig,
  AlarmHistoryItem,
  CloudProvider,
  Finding,
  Graph,
  Identity,
  InsightsRequest,
  InsightsResponse,
  LogEvent,
  LogGroupRef,
  LogQueryRequest,
  LogQueryResponse,
  MetricsRequest,
  MetricsResponse,
  Profile,
  RecentChange,
  ScanOptions,
  TailOptions,
  WafSampledRequestsRequest,
  WafSampledResponse,
  CostReport,
  RunRate,
} from '@cloudatlas/shared'
import { choosePeriod, metricsFor, primaryMetricsFor } from '@cloudatlas/shared'
import { AwsClient } from '../../aws/client.js'
import { getIdentity, listRegions } from '../../aws/identity.js'
import { listLocalProfiles } from '../../aws/profiles.js'
import type { CloudAtlasDb } from '../../db/index.js'
import { runScan } from '../../scan/run.js'
import {
  applyHealth,
  fetchAlarmHistory,
  getWafSampled,
  runHealthPass,
  type HealthPassResult,
} from '../../health/index.js'
import { fetchMetrics } from '../../metrics/index.js'
import { getDatabaseLoad } from '../../metrics/insights-db.js'
import { discoverLogGroups, queryInsights, queryLogs, tailLogs } from '../../logs/index.js'
import { lookupChanges } from '../../changes/cloudtrail.js'
import { getActualSpend, setCostExplorerEnabled } from '../../cost/actual.js'
import { loadPriceBook } from '../../cost/pricing.js'
import { planCostReport } from '../../cost/report.js'
import { estimateRunRate, neededPrices } from '../../cost/estimate.js'

export class UnknownNodeError extends Error {
  readonly statusCode = 404
  constructor(nodeId: string) {
    super(`No node "${nodeId}" in the current scan. Re-scan if the resource is new.`)
    this.name = 'UnknownNodeError'
  }
}

export class NotImplementedError extends Error {
  readonly statusCode = 501
  constructor(feature: string, milestone: string) {
    super(
      `${feature} is not implemented yet — it lands in ${milestone}. ` +
        `Run "npm run dev:demo" to explore the full UI against fixture data.`,
    )
    this.name = 'NotImplementedError'
  }
}

export interface LiveProviderOptions {
  db: CloudAtlasDb
  /** Scans to retain per profile before pruning. */
  keepScans?: number
  /** How long a health pass stays fresh. Defaults to the configured poll interval. */
  healthTtlMs?: number
  /** Opt in to Cost Explorer, which is billed per request. */
  enableCostExplorer?: boolean
  /** Local data directory, for the cost setting and the Cost Explorer cache. */
  dataDir?: string
  /** Spike-detection thresholds from cloudatlas.config.json. */
  detection?: DetectionConfig
  log?: (message: string, detail?: Record<string, unknown>) => void
}

/**
 * Real-AWS provider.
 *
 * Milestone 2 covers identity, region discovery and the topology scan. Metrics,
 * logs and health still throw a 501 rather than returning empty data that would
 * look like a healthy account.
 */
export class LiveProvider implements CloudProvider {
  readonly kind = 'live' as const

  private graph: Graph | null = null
  private alarms: Alarm[] = []
  private findings: Finding[] = []
  private currentProfile: string | null = null
  private health: HealthPassResult | null = null

  constructor(private readonly options: LiveProviderOptions) {}

  /** The profile a request should run under, or a clear error saying why not. */
  private profileOrThrow(fallback?: string): string {
    const profile = this.currentProfile ?? fallback
    if (!profile) throw new Error('No profile selected; run a scan first')
    return profile
  }

  private get healthTtlMs(): number {
    return this.options.healthTtlMs ?? 60_000
  }

  private client(profile: string): AwsClient {
    return new AwsClient({
      profile,
      mode: 'live',
      log: this.options.log,
    })
  }

  async listProfiles(): Promise<Profile[]> {
    return listLocalProfiles()
  }

  async getIdentity(profile: string): Promise<Identity> {
    const aws = this.client(profile)
    try {
      return await getIdentity(aws, profile)
    } finally {
      await aws.destroy()
    }
  }

  async listRegions(profile: string): Promise<string[]> {
    const aws = this.client(profile)
    try {
      return await listRegions(aws)
    } finally {
      await aws.destroy()
    }
  }

  async scan(options: ScanOptions): Promise<Graph> {
    const aws = this.client(options.profile)
    try {
      const identity = await getIdentity(aws, options.profile)
      const result = await runScan({
        aws,
        profile: options.profile,
        accountId: identity.accountId,
        accountAlias: identity.accountAlias,
        regions: options.regions,
        enableCostExplorer: this.options.enableCostExplorer ?? false,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })

      this.graph = result.graph
      this.alarms = result.alarms
      this.findings = result.findings
      this.currentProfile = options.profile
      this.health = null

      const scanId = randomUUID()
      this.options.db.saveScan({
        id: scanId,
        profile: options.profile,
        accountId: identity.accountId,
        regions: options.regions,
        scannedAt: result.graph.scannedAt,
        graph: result.graph,
      })
      this.options.db.saveFindings(scanId, result.findings)
      this.options.db.pruneScans(options.profile, this.options.keepScans ?? 10)

      this.options.log?.('scan complete', {
        profile: options.profile,
        regions: options.regions.join(','),
        nodes: result.graph.nodes.length,
        edges: result.graph.edges.length,
        calls: aws.stats.totalCalls,
        throttles: aws.stats.throttles,
        missingPermissions: aws.stats.accessDenied.length,
      })

      return result.graph
    } finally {
      await aws.destroy()
    }
  }

  getGraph(): Graph | null {
    if (this.graph) return this.graph
    // Survive a server restart: fall back to the last persisted scan.
    const profile = this.currentProfile ?? listLocalProfiles()[0]?.name
    if (!profile) return null
    const record = this.options.db.latestScan(profile)
    if (record) {
      this.graph = record.graph
      this.findings = this.options.db.getFindings(record.id)
    }
    return this.graph
  }

  async getMetrics(request: MetricsRequest): Promise<MetricsResponse> {
    const graph = this.getGraph()
    const node = graph?.nodes.find((candidate) => candidate.id === request.nodeId)
    if (!node) throw new UnknownNodeError(request.nodeId)

    const catalog = metricsFor(node.type)
    const defs =
      request.metricNames.length > 0
        ? catalog.filter((def) => request.metricNames.includes(def.name))
        : primaryMetricsFor(node.type)
    if (defs.length === 0) return { series: [], missingPermissions: [] }

    const period = request.period ?? choosePeriod(request.start, request.end)
    const aws = this.client(this.profileOrThrow(graph?.profile))
    try {
      const series = await fetchMetrics({
        aws,
        region: node.region,
        node,
        defs,
        period,
        start: request.start,
        end: request.end,
      })
      // A denial here is not fatal — the topology is already drawn. Report it
      // alongside the series so the empty charts are attributed, not blamed on
      // the resource.
      return {
        series,
        missingPermissions: [...aws.stats.accessDenied],
      }
    } finally {
      await aws.destroy()
    }
  }

  async listLogGroups(nodeId: string): Promise<LogGroupRef[]> {
    const graph = this.getGraph()
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new UnknownNodeError(nodeId)

    const aws = this.client(this.profileOrThrow(graph?.profile))
    try {
      return await discoverLogGroups({
        aws,
        node,
        onWarning: (action) => this.options.log?.('log group lookup denied', { action }),
      })
    } finally {
      await aws.destroy()
    }
  }

  async queryLogs(request: LogQueryRequest): Promise<LogQueryResponse> {
    const aws = this.client(this.profileOrThrow(this.getGraph()?.profile))
    try {
      return await queryLogs({ aws, request })
    } finally {
      await aws.destroy()
    }
  }

  async queryInsights(request: InsightsRequest): Promise<InsightsResponse> {
    const aws = this.client(this.profileOrThrow(this.getGraph()?.profile))
    try {
      return await queryInsights({ aws, request })
    } finally {
      await aws.destroy()
    }
  }

  // eslint-disable-next-line require-yield
  /**
   * Live tail needs the account id to build log-group ARNs, which the API
   * requires — unlike FilterLogEvents, plain names are rejected.
   */
  async *tailLogs(options: TailOptions): AsyncIterable<LogEvent[]> {
    const graph = this.getGraph()
    if (!graph) throw new Error('Run a scan before tailing logs')

    const aws = this.client(this.profileOrThrow(graph.profile))
    try {
      yield* tailLogs({ ...options, aws, accountId: graph.accountId })
    } finally {
      await aws.destroy()
    }
  }

  /**
   * Posture findings from the scan's security-group analysis. Metric anomaly
   * detection and alarm-derived findings arrive in Milestone 3.
   */
  /**
   * Posture findings from the last scan, plus live spikes from a health pass.
   *
   * The pass is cached for `healthTtlMs` because the UI polls this endpoint and
   * a CloudWatch round trip per poll would be both slow and needlessly
   * expensive. A stale-on-failure cache is deliberate: if CloudWatch is
   * unreachable, showing the last known findings with an older `evaluatedAt`
   * beats showing an empty list that reads as "everything is fine".
   */
  async getFindings(): Promise<Finding[]> {
    const graph = this.getGraph()
    if (!graph) return []

    const spikes = await this.healthPass(graph)
    const all = [...this.findings, ...spikes]
    applyHealth(graph.nodes, all)
    return all
  }

  private async healthPass(graph: Graph): Promise<Finding[]> {
    const now = Date.now()
    if (this.health && now - this.health.evaluatedAt < this.healthTtlMs) {
      return this.health.findings
    }

    const profile = this.currentProfile ?? graph.profile
    const aws = this.client(profile)
    try {
      const result = await runHealthPass({
        aws,
        graph,
        now,
        ...(this.options.detection ? { detection: this.options.detection } : {}),
      })
      this.health = result
      this.options.log?.('health pass complete', {
        profile,
        nodes: graph.nodes.length,
        findings: result.findings.length,
        calls: aws.stats.totalCalls,
      })
      return result.findings
    } catch (error) {
      // Keep the previous result rather than reporting a healthy account.
      this.options.log?.('health pass failed', { error: (error as Error).message })
      return this.health?.findings ?? []
    } finally {
      await aws.destroy()
    }
  }

  async getAlarms(state?: string): Promise<Alarm[]> {
    return state ? this.alarms.filter((alarm) => alarm.state === state) : this.alarms
  }

  async getAlarmHistory(alarmName: string, region: string): Promise<AlarmHistoryItem[]> {
    const aws = this.client(this.profileOrThrow(this.getGraph()?.profile))
    try {
      return await fetchAlarmHistory({ aws, region, alarmName })
    } finally {
      await aws.destroy()
    }
  }

  /**
   * Sampled requests for a web ACL.
   *
   * The rule metric names come from the ACL's own configuration rather than
   * being guessed: WAF requires an exact metric name, and a wrong one returns
   * an empty sample rather than an error. `ALL` covers requests the ACL handled
   * outside any named rule.
   */
  async getWafSampled(request: WafSampledRequestsRequest): Promise<WafSampledResponse> {
    const graph = this.getGraph()
    const node = graph?.nodes.find((candidate) => candidate.id === request.webAclNodeId)
    if (!node) throw new UnknownNodeError(request.webAclNodeId)

    const acl = node.raw as {
      Rules?: Array<{ Name?: string; VisibilityConfig?: { MetricName?: string } }>
    }
    const all = (acl?.Rules ?? [])
      .map((rule) => rule.VisibilityConfig?.MetricName ?? rule.Name)
      .filter((name): name is string => typeof name === 'string')
    const names = request.ruleName
      ? all.filter((name) => name === request.ruleName)
      : ['ALL', ...all]

    const scope = node.props.find((entry) => entry.k === 'Scope')?.v === 'CLOUDFRONT'
      ? 'CLOUDFRONT'
      : 'REGIONAL'
    // A CLOUDFRONT-scope ACL is only addressable through us-east-1.
    const region = scope === 'CLOUDFRONT' ? 'us-east-1' : node.region

    const aws = this.client(this.profileOrThrow(graph?.profile))
    try {
      return await getWafSampled({
        aws,
        request,
        webAclArn: node.arn ?? node.id,
        region,
        scope,
        ruleMetricNames: names,
      })
    } finally {
      await aws.destroy()
    }
  }

  async getRecentChanges(start: number, end: number): Promise<RecentChange[]> {
    const graph = this.getGraph()
    if (!graph) return []

    const aws = this.client(this.profileOrThrow(graph.profile))
    try {
      return await lookupChanges({
        aws,
        regions: graph.regions.map((region) => region.id),
        nodes: graph.nodes,
        start,
        end,
        onWarning: (action) => this.options.log?.('cloudtrail lookup denied', { action }),
      })
    } finally {
      await aws.destroy()
    }
  }

  private get dataDir(): string {
    return this.options.dataDir ?? 'data'
  }

  async getCostReport(options: { refresh?: boolean } = {}): Promise<CostReport | null> {
    const graph = this.getGraph()
    if (!graph) return null
    const aws = this.client(this.profileOrThrow(graph.profile))
    const plan = planCostReport(graph, { profile: graph.profile })
    // Prices and spend are independent; neither waits for the other.
    const [prices, actual] = await Promise.all([
      loadPriceBook(aws, plan.keys),
      getActualSpend({
        aws,
        profile: graph.profile,
        dataDir: this.dataDir,
        enabledByConfig: this.options.enableCostExplorer ?? false,
        refresh: options.refresh ?? false,
      }),
    ])
    return plan.build(prices.book, prices.failure, actual)
  }

  async estimateRunRates(graphs: Graph[]): Promise<RunRate[]> {
    const profile = graphs[0]?.profile ?? this.getGraph()?.profile
    const aws = this.client(this.profileOrThrow(profile))
    const { book, failure } = await loadPriceBook(aws, graphs.flatMap((graph) => neededPrices(graph)))
    return graphs.map((graph) => estimateRunRate(graph, book, failure))
  }

  async setCostExplorerEnabled(enabled: boolean): Promise<void> {
    setCostExplorerEnabled(this.dataDir, enabled)
  }

  async getDatabaseLoad(nodeId: string, start: number, end: number): Promise<DatabaseLoad> {
    const graph = this.getGraph()
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new UnknownNodeError(nodeId)

    const aws = this.client(this.profileOrThrow(graph?.profile))
    try {
      return await getDatabaseLoad({ aws, node, start, end })
    } finally {
      await aws.destroy()
    }
  }

  async dispose(): Promise<void> {
    this.options.db.close()
  }
}
