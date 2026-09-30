import {
  choosePeriod,
  findMetricDef,
  isContainerType,
  primaryMetricsFor,
  type Alarm,
  type AlarmHistoryItem,
  type CloudProvider,
  type Finding,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Identity,
  type InsightsRequest,
  type InsightsResponse,
  type LogEvent,
  type LogGroupRef,
  type LogQueryRequest,
  type LogQueryResponse,
  type MetricSeries,
  type MetricsRequest,
  type MetricsResponse,
  type Profile,
  type RecentChange,
  type ScanOptions,
  type TailOptions,
  type CollectorFailure,
  type DatabaseLoad,
  type MissingPermission,
  type WafSampledRequest,
  type WafSampledRequestsRequest,
  type WafSampledResponse,
} from '@cloudatlas/shared'
import { analyzeSecurityGroups } from '../../graph/sg-risk.js'
import { applyHealth, detectPosture } from '../../health/index.js'
import {
  DEMO_ACCOUNT_ALIAS,
  DEMO_ACCOUNT_ID,
  DEMO_EDGES,
  DEMO_NODES,
  DEMO_PROFILES,
  DEMO_REGIONS,
  DEMO_SECURITY_GROUPS,
} from './fixtures.js'
import {
  DEMO_EPOCH,
  DEMO_INCIDENTS,
  incidentWindow,
  sampleSeries,
  sparklineFor,
  type DemoIncident,
} from './series.js'
import { unavailableReason } from '../../metrics/index.js'
import { generateLogEvents, generateTailBatch } from './logs.js'

const MINUTE = 60_000

/**
 * A degraded scan, for exercising the "scan incomplete" banner.
 *
 * Off by default. It exists because that banner is a significant surface the
 * demo could never reach — which is how it shipped listing twenty-seven
 * identical rows over the canvas with no way to collapse it. A state that
 * cannot be reproduced locally is a state that gets reviewed only in
 * production.
 *
 * The shape mirrors a real scan: a handful of denied actions across regions,
 * and one benign error repeated once per bucket.
 */
function demoScanIssues(): { warnings: MissingPermission[]; failures: CollectorFailure[] } {
  if (process.env.CLOUDATLAS_DEMO_ISSUES !== '1') return { warnings: [], failures: [] }

  const denied = [
    ['ecs:ListClusters', 'compute'],
    ['lambda:ListEventSourceMappings', 'integration'],
    ['sqs:ListQueues', 'integration'],
    ['network-firewall:ListFirewalls', 'security'],
  ] as const

  const warnings: MissingPermission[] = []
  for (const [action, section] of denied) {
    for (const region of ['us-east-1', 'us-west-2']) {
      warnings.push({ action, region, section, message: `not authorized to perform: ${action}` })
    }
  }
  warnings.push({
    action: 'cloudfront:ListDistributions',
    region: 'global',
    section: 'network',
    message: 'not authorized to perform: cloudfront:ListDistributions',
  })

  // One cause, many occurrences — the case that produced an unreadable wall.
  const failures: CollectorFailure[] = Array.from({ length: 27 }, () => ({
    service: 'example',
    operation: 'GetSomething',
    region: 'us-east-1',
    section: 'storage',
    errorName: 'SomeUnrecognisedError',
    errorCode: 'SomeUnrecognisedError',
    message: 'an error shape the classifier does not know',
  }))

  return { warnings, failures }
}


/**
 * Map a caller's wall-clock window onto the fixture account's timeline.
 *
 * The demo simulates an account whose "now" is DEMO_EPOCH, and every incident,
 * log line and sampled request is positioned relative to it. The UI, correctly,
 * asks for "the last hour" using `Date.now()`. When those two clocks are not
 * the same instant — because the epoch was pinned for a test, or simply because
 * a session has been running for a while — filtering fixture data against the
 * caller's window returns nothing.
 *
 * That failure is the one this whole project is built to avoid: an empty result
 * that reads as "everything is fine". So the window's *duration* is honoured
 * and its position is moved onto demo time.
 */
function toDemoWindow(start: number, end: number): { start: number; end: number } {
  const span = Math.max(60_000, end - start)
  return { start: DEMO_EPOCH - span, end: DEMO_EPOCH }
}


/** Collector names replayed in the first-run progress list. */
const COLLECTOR_STEPS = [
  'ec2',
  'vpc',
  'elbv2',
  'rds',
  'elasticache',
  'ecs',
  'lambda',
  's3',
  'cloudfront',
  'wafv2',
  'sqs',
  'security-groups',
]

/** Tests exercise the same scan path, but without the cosmetic pacing. */
const INSTANT_SCAN = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

function sleep(ms: number): Promise<void> {
  if (INSTANT_SCAN) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Log groups the fixture actually provisioned, plus ones a real account would miss. */
const LOG_GROUP_CATALOG: Record<
  string,
  { kind: string; exists: boolean; hint: string | null; storedBytes: number | null }
> = {
  '/aws/rds/instance/prod-pg-primary/postgresql': { kind: 'rds', exists: true, hint: null, storedBytes: 2_140_000_000 },
  '/aws/rds/instance/prod-pg-primary/slowquery': {
    kind: 'rds',
    exists: false,
    hint: 'Enable the slowquery log export on prod-pg-primary to collect this group.',
    storedBytes: null,
  },
  '/aws/rds/instance/prod-pg-standby/postgresql': { kind: 'rds', exists: true, hint: null, storedBytes: 410_000_000 },
  '/aws/rds/instance/dr-pg-replica/postgresql': { kind: 'rds', exists: true, hint: null, storedBytes: 88_000_000 },
  '/ecs/cortex-api': { kind: 'ecs', exists: true, hint: null, storedBytes: 9_800_000_000 },
  '/ecs/cortex-api-dr': { kind: 'ecs', exists: true, hint: null, storedBytes: 210_000_000 },
  '/aws/lambda/image-resize': { kind: 'lambda', exists: true, hint: null, storedBytes: 640_000_000 },
  '/aws/lambda/dr-state-sync': { kind: 'lambda', exists: true, hint: null, storedBytes: 21_000_000 },
  '/aws/lambda/eu-consent-gate': { kind: 'lambda', exists: true, hint: null, storedBytes: 48_000_000 },
  'aws-waf-logs-cortex': { kind: 'waf', exists: true, hint: null, storedBytes: 4_400_000_000 },
  '/aws/network-firewall/prod': { kind: 'firewall', exists: true, hint: null, storedBytes: 1_200_000_000 },
  '/aws/vpc/flowlogs/prod-vpc': { kind: 'flowlog', exists: true, hint: null, storedBytes: 18_000_000_000 },
  '/aws/vpc/flowlogs/dr-vpc': { kind: 'flowlog', exists: true, hint: null, storedBytes: 900_000_000 },
}

/** Extra groups a node should offer beyond the ones stored on the node itself. */
const EXTRA_NODE_LOG_GROUPS: Record<string, string[]> = {
  'rds-primary': ['/aws/rds/instance/prod-pg-primary/slowquery'],
  alb: [],
}

const ALARM_DEFS: Array<{
  name: string
  nodeId: string
  metricName: string
  namespace: string
  region: string
  threshold: number
  comparisonOperator: string
  state: Alarm['state']
  reason: string
}> = [
  {
    name: 'prod-pg-primary-cpu-high',
    nodeId: 'rds-primary',
    metricName: 'CPUUtilization',
    namespace: 'AWS/RDS',
    region: 'us-east-1',
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'ALARM',
    reason:
      'Threshold Crossed: 3 out of the last 3 datapoints [93.4, 92.1, 91.8] were greater than the threshold (80.0).',
  },
  {
    name: 'prod-pg-primary-connections-high',
    nodeId: 'rds-primary',
    metricName: 'DatabaseConnections',
    namespace: 'AWS/RDS',
    region: 'us-east-1',
    threshold: 1200,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'ALARM',
    reason:
      'Threshold Crossed: 2 out of the last 2 datapoints [1420.0, 1388.0] were greater than the threshold (1200.0).',
  },
  {
    name: 'batch-runner-status-check',
    nodeId: 'ec2-batch',
    metricName: 'StatusCheckFailed_Instance',
    namespace: 'AWS/EC2',
    region: 'us-east-1',
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'ALARM',
    reason: 'Threshold Crossed: 1 datapoint [1.0] was greater than the threshold (0.0).',
  },
  {
    name: 'api-alb-target-5xx',
    nodeId: 'alb',
    metricName: 'HTTPCode_Target_5XX_Count',
    namespace: 'AWS/ApplicationELB',
    region: 'us-east-1',
    threshold: 10,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'ALARM',
    reason: 'Threshold Crossed: 2 out of the last 3 datapoints were greater than the threshold (10.0).',
  },
  {
    name: 'cortex-cache-evictions',
    nodeId: 'redis',
    metricName: 'Evictions',
    namespace: 'AWS/ElastiCache',
    region: 'us-east-1',
    threshold: 100,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'OK',
    reason: 'Threshold Crossed: no datapoints were greater than the threshold (100.0).',
  },
  {
    name: 'resize-jobs-age-of-oldest',
    nodeId: 'sqs',
    metricName: 'ApproximateAgeOfOldestMessage',
    namespace: 'AWS/SQS',
    region: 'us-east-1',
    threshold: 300,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'OK',
    reason: 'Threshold Crossed: no datapoints were greater than the threshold (300.0).',
  },
  {
    name: 'prod-pg-primary-free-storage',
    nodeId: 'rds-primary',
    metricName: 'FreeStorageSpace',
    namespace: 'AWS/RDS',
    region: 'us-east-1',
    threshold: 100,
    comparisonOperator: 'LessThanThreshold',
    state: 'OK',
    reason: 'Threshold Crossed: no datapoints were less than the threshold (100.0).',
  },
  {
    name: 'dr-pg-replica-lag',
    nodeId: 'dr-rds',
    metricName: 'ReplicaLag',
    namespace: 'AWS/RDS',
    region: 'us-west-2',
    threshold: 60,
    comparisonOperator: 'GreaterThanThreshold',
    state: 'INSUFFICIENT_DATA',
    reason: 'Insufficient Data: 1 datapoint was unknown.',
  },
]

function findingFromIncident(incident: DemoIncident): Finding {
  const { start, end } = incidentWindow(incident)
  return {
    id: incident.id,
    nodeId: incident.nodeId,
    severity: incident.severity,
    kind: incident.kind,
    title: incident.title,
    detail: incident.detail,
    metric: incident.metric,
    startedAt: start,
    endedAt: end,
    evidence: incident.evidence,
    sparkline: incident.metric ? sparklineFor(incident.nodeId, incident.metric) : [],
    logGroups: incident.logGroups,
  }
}

export class DemoProvider implements CloudProvider {
  readonly kind = 'demo' as const

  private graph: Graph | null = null
  private sgFindings: Finding[] = []
  private postureFindings: Finding[] = []

  async listProfiles(): Promise<Profile[]> {
    return DEMO_PROFILES.map((p) => ({ ...p }))
  }

  async getIdentity(profile: string): Promise<Identity> {
    return {
      accountId: DEMO_ACCOUNT_ID,
      accountAlias: DEMO_ACCOUNT_ALIAS,
      arn: `arn:aws:sts::${DEMO_ACCOUNT_ID}:assumed-role/AWSReservedSSO_ReadOnly/${profile}`,
      userId: 'AROA4EXAMPLEDEMO:cloudatlas',
      profile,
    }
  }

  async listRegions(): Promise<string[]> {
    return [...DEMO_REGIONS]
  }

  async scan(options: ScanOptions): Promise<Graph> {
    const { profile, regions, onProgress, signal } = options
    const selected = new Set(regions)

    for (const region of regions) {
      onProgress?.({ region, state: 'queued', progress: 0, step: null, resourceCount: 0, error: null })
    }

    // Replay a plausible collector sequence so the first-run screen has
    // something real to stream. Regions run concurrently, like the live scan.
    await Promise.all(
      regions.map(async (region, regionIndex) => {
        const regionNodes = DEMO_NODES.filter(
          (n) => n.region === region && !isContainerType(n.type) && n.type !== 'internet',
        )
        // Stagger region starts slightly, as a concurrency-limited scan would.
        await sleep(regionIndex * 90)
        for (const [stepIndex, step] of COLLECTOR_STEPS.entries()) {
          if (signal?.aborted) return
          await sleep(55 + ((stepIndex * 37) % 60))
          const progress = (stepIndex + 1) / COLLECTOR_STEPS.length
          onProgress?.({
            region,
            state: 'scanning',
            progress,
            step,
            resourceCount: Math.round(regionNodes.length * progress),
            error: null,
          })
        }
        onProgress?.({
          region,
          state: 'done',
          progress: 1,
          step: null,
          resourceCount: regionNodes.length,
          error: null,
        })
      }),
    )

    const nodes = DEMO_NODES.filter(
      (n) => n.region === 'global' || selected.has(n.region),
    ).map((n) => ({ ...n }))
    const nodeIds = new Set(nodes.map((n) => n.id))

    const vpcIds = new Set(nodes.filter((n) => n.type === 'vpc').map((n) => n.id))
    const securityGroups = DEMO_SECURITY_GROUPS.filter(
      (sg) => sg.vpcId === null || vpcIds.has(sg.vpcId),
    )

    const analysis = analyzeSecurityGroups(securityGroups, nodes, Date.now())
    this.sgFindings = analysis.findings

    const edges: GraphEdge[] = [
      ...DEMO_EDGES.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)),
      ...analysis.sgEdges,
      ...analysis.riskEdges,
    ]

    this.postureFindings = detectPosture(nodes, Date.now())
    const findings = [
      ...DEMO_INCIDENTS.filter((i) => nodeIds.has(i.nodeId)).map(findingFromIncident),
      ...analysis.findings,
      ...this.postureFindings,
    ]
    applyHealth(nodes, findings)

    const graph: Graph = {
      nodes,
      edges,
      securityGroups: analysis.securityGroups,
      regions: DEMO_REGIONS.map((id) => ({
        id,
        count: DEMO_NODES.filter((n) => n.region === id && !isContainerType(n.type) && n.type !== 'internet')
          .length,
      })),
      missingPermissions: demoScanIssues().warnings,
      collectorFailures: demoScanIssues().failures,
      scannedAt: Date.now(),
      accountId: DEMO_ACCOUNT_ID,
      accountAlias: DEMO_ACCOUNT_ALIAS,
      profile,
    }
    this.graph = graph
    return graph
  }

  getGraph(): Graph | null {
    return this.graph
  }

  private nodeById(nodeId: string): GraphNode | undefined {
    return (this.graph?.nodes ?? DEMO_NODES).find((n) => n.id === nodeId)
  }

  async getMetrics(request: MetricsRequest): Promise<MetricsResponse> {
    const node = this.nodeById(request.nodeId)
    if (!node) return { series: [], missingPermissions: [] }

    const defs =
      request.metricNames.length > 0
        ? request.metricNames
            .map((name) => findMetricDef(node.type, name))
            .filter((d): d is NonNullable<typeof d> => d !== undefined)
        : primaryMetricsFor(node.type)

    const window = toDemoWindow(request.start, request.end)
    const period = request.period ?? choosePeriod(window.start, window.end)

    const series: MetricSeries[] = defs.map((def) => {
      const reason = unavailableReason(node, def)
      if (reason) {
        return {
          nodeId: node.id,
          metricName: def.name,
          namespace: def.namespace,
          label: def.label,
          unit: def.unit,
          stat: request.stat ?? def.stat,
          timestamps: [],
          values: [],
          period,
          unavailableReason: reason,
        }
      }
      const sampled = sampleSeries(node.id, def.name, window.start, window.end, period)
      // The demo baselines are written in the units people read (latency in
      // ms, memory in GB), but a provider must return what CloudWatch returns
      // — seconds, bytes — because the UI applies the catalog's display scale.
      // Without this, read latency showed as 33,853 ms and memory as ~0 GB.
      const scale = def.scale ?? 1
      const values = scale === 1 ? sampled.values : sampled.values.map((v) => (v === null ? null : v / scale))
      return {
        nodeId: node.id,
        metricName: def.name,
        namespace: def.namespace,
        label: def.label,
        unit: def.unit,
        stat: request.stat ?? def.stat,
        timestamps: sampled.timestamps,
        values,
        period,
        unavailableReason: null,
      }
    })

    return { series, missingPermissions: [] }
  }

  async listLogGroups(nodeId: string): Promise<LogGroupRef[]> {
    const node = this.nodeById(nodeId)
    if (!node) return []
    const names = [...node.logGroups, ...(EXTRA_NODE_LOG_GROUPS[nodeId] ?? [])]
    const region = node.region === 'global' ? 'us-east-1' : node.region

    const refs: LogGroupRef[] = names.map((name) => {
      const meta = LOG_GROUP_CATALOG[name]
      return {
        name,
        kind: meta?.kind ?? 'generic',
        region,
        exists: meta?.exists ?? true,
        hint: meta?.hint ?? null,
        storedBytes: meta?.storedBytes ?? null,
      }
    })

    // An ALB's access logs go to S3, not CloudWatch — say so rather than
    // showing an empty picker.
    if (node.type === 'alb' || node.type === 'nlb') {
      refs.push({
        name: 's3://prod-logs/alb/',
        kind: 'alb-access-logs',
        region,
        exists: false,
        hint: 'ALB access logs are delivered to S3, not CloudWatch Logs. Query them with Athena.',
        storedBytes: null,
      })
    }
    return refs
  }

  async queryLogs(request: LogQueryRequest): Promise<LogQueryResponse> {
    const window = toDemoWindow(request.start, request.end)
    const events: LogEvent[] = []
    const histogram = new Map<number, number>()
    let truncated = false

    const perGroupLimit = Math.max(1, Math.floor(request.limit / request.logGroups.length))
    for (const group of request.logGroups) {
      const meta = LOG_GROUP_CATALOG[group]
      if (meta && !meta.exists) continue
      const generated = generateLogEvents(
        group,
        window.start,
        window.end,
        request.filterPattern,
        perGroupLimit,
      )
      events.push(...generated.events)
      truncated ||= generated.truncated
      for (const bucket of generated.histogram) {
        histogram.set(bucket.t, (histogram.get(bucket.t) ?? 0) + bucket.count)
      }
    }

    events.sort((a, b) => a.timestamp - b.timestamp)
    return {
      events,
      truncated,
      histogram: [...histogram.entries()]
        .map(([t, count]) => ({ t, count }))
        .sort((a, b) => a.t - b.t),
      missingPermissions: [],
    }
  }

  async queryInsights(_request: InsightsRequest): Promise<InsightsResponse> {
    throw Object.assign(
      new Error('CloudWatch Logs Insights arrives in Milestone 4.'),
      { statusCode: 501 },
    )
  }

  async *tailLogs(options: TailOptions): AsyncIterable<LogEvent[]> {
    let since = Date.now()
    while (!options.signal.aborted) {
      await sleep(2000)
      if (options.signal.aborted) return
      const until = Date.now()
      const batch: LogEvent[] = []
      for (const group of options.logGroups) {
        const meta = LOG_GROUP_CATALOG[group]
        if (meta && !meta.exists) continue
        batch.push(...generateTailBatch(group, since, until))
      }
      since = until
      if (batch.length > 0) {
        batch.sort((a, b) => a.timestamp - b.timestamp)
        yield batch
      }
    }
  }

  async getFindings(): Promise<Finding[]> {
    const nodeIds = new Set((this.graph?.nodes ?? DEMO_NODES).map((n) => n.id))
    const incidents = DEMO_INCIDENTS.filter((i) => nodeIds.has(i.nodeId)).map(findingFromIncident)
    return [...incidents, ...this.sgFindings, ...this.postureFindings]
  }

  async getAlarms(state?: string): Promise<Alarm[]> {
    const regions = new Set((this.graph?.regions ?? []).map((r) => r.id))
    const nodeIds = new Set((this.graph?.nodes ?? DEMO_NODES).map((n) => n.id))
    return ALARM_DEFS.filter((a) => nodeIds.has(a.nodeId))
      .filter((a) => regions.size === 0 || regions.has(a.region))
      .filter((a) => !state || a.state === state)
      .map((a) => ({
        name: a.name,
        arn: `arn:aws:cloudwatch:${a.region}:${DEMO_ACCOUNT_ID}:alarm:${a.name}`,
        state: a.state,
        reason: a.reason,
        updatedAt: a.state === 'ALARM' ? DEMO_EPOCH - 18 * MINUTE : DEMO_EPOCH - 6 * 60 * MINUTE,
        metricName: a.metricName,
        namespace: a.namespace,
        nodeId: a.nodeId,
        region: a.region,
        threshold: a.threshold,
        comparisonOperator: a.comparisonOperator,
      }))
  }

  async getAlarmHistory(alarmName: string): Promise<AlarmHistoryItem[]> {
    const def = ALARM_DEFS.find((a) => a.name === alarmName)
    if (!def) return []
    if (def.state !== 'ALARM') {
      return [
        {
          timestamp: DEMO_EPOCH - 6 * 60 * MINUTE,
          summary: `Alarm updated from INSUFFICIENT_DATA to OK`,
          state: 'OK',
        },
      ]
    }
    return [
      {
        timestamp: DEMO_EPOCH - 18 * MINUTE,
        summary: `Alarm updated from OK to ALARM. ${def.reason}`,
        state: 'ALARM',
      },
      {
        timestamp: DEMO_EPOCH - 22 * MINUTE,
        summary: 'Alarm updated from ALARM to OK (brief recovery)',
        state: 'OK',
      },
      {
        timestamp: DEMO_EPOCH - 24 * MINUTE,
        summary: `Alarm updated from OK to ALARM. ${def.reason}`,
        state: 'ALARM',
      },
    ]
  }

  async getWafSampled(request: WafSampledRequestsRequest): Promise<WafSampledResponse> {
    const { start, end } = toDemoWindow(request.start, request.end)
    const requests: WafSampledRequest[] = []
    const step = Math.max(1000, Math.floor((end - start) / 400))

    for (let t = start; t <= end; t += step) {
      const { events } = generateLogEvents('aws-waf-logs-cortex', t, t + step, '', 2)
      for (const event of events) {
        const parsed = event.json as
          | {
              action?: string
              terminatingRuleId?: string
              httpRequest?: { clientIp?: string; country?: string; uri?: string; httpMethod?: string }
            }
          | undefined
        if (!parsed || parsed.action !== 'BLOCK') continue
        if (request.ruleName && parsed.terminatingRuleId !== request.ruleName) continue
        requests.push({
          timestamp: event.timestamp,
          clientIp: parsed.httpRequest?.clientIp ?? '0.0.0.0',
          country: parsed.httpRequest?.country ?? '--',
          uri: parsed.httpRequest?.uri ?? '/',
          method: parsed.httpRequest?.httpMethod ?? 'GET',
          action: parsed.action,
          ruleName: parsed.terminatingRuleId ?? 'Default_Action',
          weight: 1,
        })
      }
    }

    const tally = (key: (r: WafSampledRequest) => string) => {
      const counts = new Map<string, number>()
      for (const r of requests) counts.set(key(r), (counts.get(key(r)) ?? 0) + r.weight)
      return [...counts.entries()]
        .map(([k, count]) => ({ key: k, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25)
    }

    return {
      requests,
      byRule: tally((r) => r.ruleName),
      byClientIp: tally((r) => r.clientIp),
      byCountry: tally((r) => r.country),
      byUri: tally((r) => r.uri),
    }
  }

  async getRecentChanges(start: number, end: number): Promise<RecentChange[]> {
    const changes: RecentChange[] = [
      {
        timestamp: DEMO_EPOCH - 34 * MINUTE,
        eventName: 'ModifyDBParameterGroup',
        eventSource: 'rds.amazonaws.com',
        username: 'deploy-ci',
        resources: ['prod-pg15'],
        region: 'us-east-1',
        nodeId: 'rds-primary',
      },
      {
        timestamp: DEMO_EPOCH - 51 * MINUTE,
        eventName: 'UpdateService',
        eventSource: 'ecs.amazonaws.com',
        username: 'deploy-ci',
        resources: ['arn:aws:ecs:us-east-1:482177301192:service/prod/cortex-api'],
        region: 'us-east-1',
        nodeId: 'ecs-1',
      },
      {
        timestamp: DEMO_EPOCH - 63 * MINUTE,
        eventName: 'UpdateWebACL',
        eventSource: 'wafv2.amazonaws.com',
        username: 'security-eng',
        resources: ['cortex-waf'],
        region: 'us-east-1',
        nodeId: 'waf',
      },
      {
        timestamp: DEMO_EPOCH - 4 * 60 * MINUTE,
        eventName: 'AuthorizeSecurityGroupIngress',
        eventSource: 'ec2.amazonaws.com',
        username: 'ops-oncall',
        resources: ['sg-0e91aa30'],
        region: 'us-east-1',
        nodeId: 'ec2-legacy',
      },
    ]
    const window = toDemoWindow(start, end)
    return changes.filter((c) => c.timestamp >= window.start && c.timestamp <= window.end)
  }

  async getDatabaseLoad(nodeId: string, start: number, end: number): Promise<DatabaseLoad> {
    const node = this.nodeById(nodeId)
    if (!node || node.type !== 'rds') {
      return {
        nodeId,
        averageLoad: null,
        vcpus: null,
        topSql: [],
        topWaits: [],
        unavailableReason: 'Performance Insights is only available for RDS instances.',
      }
    }
    // The standby has Performance Insights off, which is the empty state worth
    // being able to see in the demo.
    if (!node.props.some((p) => p.k === 'Performance Insights' && p.v.startsWith('enabled'))) {
      return {
        nodeId,
        averageLoad: null,
        vcpus: null,
        topSql: [],
        topWaits: [],
        unavailableReason: `Performance Insights is not enabled on ${node.name}. Enable it on the instance to see which statements and wait events are driving load.`,
      }
    }

    const spiking = DEMO_INCIDENTS.some(
      (incident) => incident.nodeId === nodeId && incident.kind === 'metric-spike',
    )
    void toDemoWindow(start, end)

    return spiking
      ? {
          nodeId,
          averageLoad: 14.8,
          vcpus: 8,
          topSql: [
            { label: 'SELECT * FROM appointments WHERE clinician_id = ? AND starts_at BETWEEN ? AND ?', load: 8.1, share: 0.55 },
            { label: 'UPDATE encounters SET status = ? WHERE id = ?', load: 3.2, share: 0.22 },
            { label: 'SELECT count(*) FROM lab_results WHERE patient_id = ?', load: 1.6, share: 0.11 },
          ],
          topWaits: [
            { label: 'LWLock:BufferContent', load: 6.4, share: 0.43 },
            { label: 'Lock:transactionid', load: 4.1, share: 0.28 },
            { label: 'CPU', load: 2.9, share: 0.2 },
          ],
          unavailableReason: null,
        }
      : {
          nodeId,
          averageLoad: 0.7,
          vcpus: 8,
          topSql: [
            { label: 'SELECT 1', load: 0.3, share: 0.43 },
            { label: 'SELECT * FROM schema_migrations', load: 0.2, share: 0.29 },
          ],
          topWaits: [{ label: 'CPU', load: 0.5, share: 0.71 }],
          unavailableReason: null,
        }
  }
}
