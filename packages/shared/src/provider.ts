import type { Alarm, CollectorFailure, Finding, Graph, MissingPermission } from './graph.js'
import type { CostReport, RunRate } from './cost.js'
import type { DatabaseLoad, MetricsRequest, MetricsResponse } from './metrics.js'
import type {
  InsightsRequest,
  InsightsResponse,
  LogEvent,
  LogGroupRef,
  LogQueryRequest,
  LogQueryResponse,
} from './logs.js'
import type {
  AlarmHistoryItem,
  Identity,
  Profile,
  ScanProgress,
  WafSampledRequestsRequest,
  WafSampledResponse,
} from './api.js'

export interface ScanOptions {
  profile: string
  regions: string[]
  /** Called as each region advances so the first-run screen can stream progress. */
  onProgress?: (progress: ScanProgress) => void
  /** Called for each AccessDenied so the scan degrades instead of failing. */
  onWarning?: (warning: MissingPermission) => void
  /** Called for each failure no classifier recognised. */
  onFailure?: (failure: CollectorFailure) => void
  signal?: AbortSignal
}

export interface TailOptions {
  logGroups: string[]
  region: string
  filterPattern?: string
  signal: AbortSignal
}

export interface RecentChange {
  timestamp: number
  eventName: string
  eventSource: string
  username: string | null
  /** Resource identifiers touched by the event. */
  resources: string[]
  region: string
  /** Matching graph node, when we could resolve one. */
  nodeId: string | null
}

/**
 * The single seam between the app and AWS. The live provider talks to the SDK;
 * the demo provider serves fixtures. Every route and every agent tool goes
 * through this interface, so demo mode exercises the same code paths.
 */
export interface CloudProvider {
  readonly kind: 'live' | 'demo'

  listProfiles(): Promise<Profile[]>
  getIdentity(profile: string): Promise<Identity>
  listRegions(profile: string): Promise<string[]>

  scan(options: ScanOptions): Promise<Graph>
  /** Last completed scan, or null before the first one. */
  getGraph(): Graph | null

  getMetrics(request: MetricsRequest): Promise<MetricsResponse>

  listLogGroups(nodeId: string): Promise<LogGroupRef[]>
  queryLogs(request: LogQueryRequest): Promise<LogQueryResponse>
  queryInsights(request: InsightsRequest): Promise<InsightsResponse>
  /** Async iterator so the route can pipe straight into SSE. */
  tailLogs(options: TailOptions): AsyncIterable<LogEvent[]>

  getFindings(): Promise<Finding[]>
  getAlarms(state?: string): Promise<Alarm[]>
  getAlarmHistory(alarmName: string, region: string): Promise<AlarmHistoryItem[]>

  getWafSampled(request: WafSampledRequestsRequest): Promise<WafSampledResponse>
  getRecentChanges(start: number, end: number): Promise<RecentChange[]>
  /** Performance Insights load breakdown for an RDS node. */
  getDatabaseLoad(nodeId: string, start: number, end: number): Promise<DatabaseLoad>

  /** Actual spend, estimated run-rate and savings for the last scan; null before one. */
  getCostReport(options?: { refresh?: boolean }): Promise<CostReport | null>
  /** Cost Explorer bills per request, so turning it on is the user's call. */
  setCostExplorerEnabled(enabled: boolean): Promise<void>
  /** Estimated run-rate for each graph, priced together — used to compare a simulation with its snapshot. */
  estimateRunRates(graphs: Graph[]): Promise<RunRate[]>

  dispose?(): Promise<void>
}
