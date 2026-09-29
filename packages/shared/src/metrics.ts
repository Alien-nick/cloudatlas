import { z } from 'zod'
import type { NodeType } from './graph.js'

export const metricStatSchema = z.enum([
  'Average',
  'Sum',
  'Maximum',
  'Minimum',
  'p50',
  'p95',
  'p99',
])
export type MetricStat = z.infer<typeof metricStatSchema>

export interface MetricDef {
  /** CloudWatch metric name. */
  name: string
  namespace: string
  /** Display name in the Metrics tab. */
  label: string
  /** Display unit suffix; empty string for counts. */
  unit: string
  /**
   * Multiplier from the unit CloudWatch publishes to the unit we display.
   *
   * AWS does not publish in the units people read in. `ReadLatency` is
   * seconds, `FreeableMemory` is bytes, `NetworkIn` is bytes per period. A
   * catalog that merely *labels* those as ms and GB is not a cosmetic problem:
   * it reports a 400-microsecond latency as "0.00 ms" and eight gigabytes of
   * free memory as eight billion.
   *
   * Display only. The detectors compare against raw CloudWatch values, so
   * alertFloor and alertCeiling stay in the published unit and are unaffected.
   */
  scale?: number
  stat: MetricStat
  /** Logical grouping shown as a section header. */
  group: string
  /** Rendered in the detail panel by default. */
  primary?: boolean
  /** True when a rising value is bad (errors, latency, blocked requests). */
  higherIsWorse?: boolean
  /**
   * True when a falling value is bad — free memory, free storage, burst
   * credits, healthy hosts. The spike detector only looks at metrics that
   * declare a direction: without one there is no way to tell an alarming change
   * from an ordinary one, and guessing produces noise.
   */
  lowerIsWorse?: boolean
  /** Absolute floor a rising anomaly must cross before it is reported. */
  alertFloor?: number
  /** Absolute level a falling anomaly must drop below before it is reported. */
  alertCeiling?: number
  /** Upper bound for the y-axis when the metric is a percentage. */
  percent?: boolean
  /** Shown when the metric is unavailable, e.g. "install the CloudWatch agent". */
  requires?: string
  /**
   * CloudWatch publishes this metric per target group rather than per load
   * balancer. Querying it with only the LoadBalancer dimension returns an empty
   * result, not an error, so it is expanded into one series per target group.
   */
  perTargetGroup?: boolean
}

const RDS: MetricDef[] = [
  { name: 'CPUUtilization', namespace: 'AWS/RDS', label: 'CPU utilization', unit: '%', stat: 'Average', group: 'Load & connections', primary: true, higherIsWorse: true, alertFloor: 70, percent: true },
  { name: 'DatabaseConnections', namespace: 'AWS/RDS', label: 'Database connections', unit: '', stat: 'Average', group: 'Load & connections', primary: true, higherIsWorse: true },
  { name: 'FreeableMemory', namespace: 'AWS/RDS', label: 'Freeable memory', unit: 'GB', scale: 1 / 1e9, stat: 'Average', group: 'Load & connections', lowerIsWorse: true },
  { name: 'ReadLatency', namespace: 'AWS/RDS', label: 'Read latency', unit: 'ms', scale: 1000, stat: 'Average', group: 'Latency & IO', primary: true, higherIsWorse: true },
  { name: 'WriteLatency', namespace: 'AWS/RDS', label: 'Write latency', unit: 'ms', scale: 1000, stat: 'Average', group: 'Latency & IO', higherIsWorse: true },
  { name: 'ReadIOPS', namespace: 'AWS/RDS', label: 'Read IOPS', unit: '/s', stat: 'Average', group: 'Latency & IO' },
  { name: 'WriteIOPS', namespace: 'AWS/RDS', label: 'Write IOPS', unit: '/s', stat: 'Average', group: 'Latency & IO' },
  { name: 'DiskQueueDepth', namespace: 'AWS/RDS', label: 'Disk queue depth', unit: '', stat: 'Average', group: 'Latency & IO', higherIsWorse: true },
  { name: 'FreeStorageSpace', namespace: 'AWS/RDS', label: 'Free storage', unit: 'GB', scale: 1 / 1e9, stat: 'Average', group: 'Storage & replication', lowerIsWorse: true },
  { name: 'ReplicaLag', namespace: 'AWS/RDS', label: 'Replica lag', unit: 's', stat: 'Average', group: 'Storage & replication', higherIsWorse: true },
  { name: 'SwapUsage', namespace: 'AWS/RDS', label: 'Swap usage', unit: 'MB', scale: 1 / 1e6, stat: 'Average', group: 'Storage & replication', higherIsWorse: true },
  { name: 'BurstBalance', namespace: 'AWS/RDS', label: 'Burst balance', unit: '%', stat: 'Average', group: 'Storage & replication', percent: true, requires: 'gp2 storage', lowerIsWorse: true, alertCeiling: 20 },
]

const EC2: MetricDef[] = [
  { name: 'CPUUtilization', namespace: 'AWS/EC2', label: 'CPU utilization', unit: '%', stat: 'Average', group: 'Core', primary: true, higherIsWorse: true, alertFloor: 80, percent: true },
  { name: 'StatusCheckFailed_Instance', namespace: 'AWS/EC2', label: 'Instance status check', unit: '', stat: 'Maximum', group: 'Core', primary: true, higherIsWorse: true, alertFloor: 1 },
  { name: 'StatusCheckFailed_System', namespace: 'AWS/EC2', label: 'System status check', unit: '', stat: 'Maximum', group: 'Core', primary: true, higherIsWorse: true, alertFloor: 1 },
  { name: 'NetworkIn', namespace: 'AWS/EC2', label: 'Network in', unit: 'MB', scale: 1 / 1e6, stat: 'Average', group: 'Network & disk' },
  { name: 'NetworkOut', namespace: 'AWS/EC2', label: 'Network out', unit: 'MB', scale: 1 / 1e6, stat: 'Average', group: 'Network & disk' },
  { name: 'EBSReadOps', namespace: 'AWS/EC2', label: 'EBS read ops', unit: '/s', stat: 'Average', group: 'Network & disk' },
  { name: 'EBSWriteOps', namespace: 'AWS/EC2', label: 'EBS write ops', unit: '/s', stat: 'Average', group: 'Network & disk' },
  { name: 'CPUCreditBalance', namespace: 'AWS/EC2', label: 'CPU credit balance', unit: '', stat: 'Average', group: 'Burstable', requires: 't-family instance', lowerIsWorse: true, alertCeiling: 20 },
  { name: 'mem_used_percent', namespace: 'CWAgent', label: 'Memory used', unit: '%', stat: 'Average', group: 'CloudWatch agent', percent: true, higherIsWorse: true, requires: 'CloudWatch agent' },
  { name: 'disk_used_percent', namespace: 'CWAgent', label: 'Disk used', unit: '%', stat: 'Average', group: 'CloudWatch agent', percent: true, higherIsWorse: true, requires: 'CloudWatch agent' },
]

const ELASTICACHE: MetricDef[] = [
  { name: 'EngineCPUUtilization', namespace: 'AWS/ElastiCache', label: 'Engine CPU', unit: '%', stat: 'Average', group: 'Core', primary: true, higherIsWorse: true, alertFloor: 75, percent: true },
  { name: 'CurrConnections', namespace: 'AWS/ElastiCache', label: 'Connections', unit: '', stat: 'Average', group: 'Core', primary: true },
  { name: 'Evictions', namespace: 'AWS/ElastiCache', label: 'Evictions', unit: '', stat: 'Sum', group: 'Core', primary: true, higherIsWorse: true },
  { name: 'DatabaseMemoryUsagePercentage', namespace: 'AWS/ElastiCache', label: 'Memory usage', unit: '%', stat: 'Average', group: 'Core', higherIsWorse: true, percent: true },
]

const ALB: MetricDef[] = [
  { name: 'RequestCount', namespace: 'AWS/ApplicationELB', label: 'Request count', unit: '/min', stat: 'Sum', group: 'Traffic', primary: true },
  { name: 'TargetResponseTime', namespace: 'AWS/ApplicationELB', label: 'Target response p95', unit: 's', stat: 'p95', group: 'Traffic', primary: true, higherIsWorse: true },
  { name: 'HTTPCode_Target_5XX_Count', namespace: 'AWS/ApplicationELB', label: 'Target 5XX', unit: '', stat: 'Sum', group: 'Errors', primary: true, higherIsWorse: true, alertFloor: 5 },
  { name: 'HTTPCode_ELB_5XX_Count', namespace: 'AWS/ApplicationELB', label: 'ELB 5XX', unit: '', stat: 'Sum', group: 'Errors', higherIsWorse: true, alertFloor: 5 },
  { name: 'UnHealthyHostCount', namespace: 'AWS/ApplicationELB', label: 'Unhealthy hosts', unit: '', stat: 'Maximum', group: 'Errors', higherIsWorse: true, alertFloor: 1, perTargetGroup: true },
  { name: 'HealthyHostCount', namespace: 'AWS/ApplicationELB', label: 'Healthy hosts', unit: '', stat: 'Minimum', group: 'Errors', perTargetGroup: true, lowerIsWorse: true, alertCeiling: 1 },
]

/**
 * NLBs publish to a different namespace with different metric names. Reusing
 * the ALB catalog here would query AWS/ApplicationELB for a net/* load balancer
 * and get back an empty series that reads as "no traffic".
 */
const NLB: MetricDef[] = [
  { name: 'ActiveFlowCount', namespace: 'AWS/NetworkELB', label: 'Active flows', unit: '', stat: 'Average', group: 'Traffic', primary: true },
  { name: 'NewFlowCount', namespace: 'AWS/NetworkELB', label: 'New flows', unit: '/min', stat: 'Sum', group: 'Traffic', primary: true },
  { name: 'ProcessedBytes', namespace: 'AWS/NetworkELB', label: 'Processed bytes', unit: 'GB', scale: 1 / 1e9, stat: 'Sum', group: 'Traffic' },
  { name: 'TCP_Target_Reset_Count', namespace: 'AWS/NetworkELB', label: 'Target resets', unit: '', stat: 'Sum', group: 'Errors', primary: true, higherIsWorse: true, alertFloor: 5 },
  { name: 'UnHealthyHostCount', namespace: 'AWS/NetworkELB', label: 'Unhealthy hosts', unit: '', stat: 'Maximum', group: 'Errors', higherIsWorse: true, alertFloor: 1, perTargetGroup: true },
  { name: 'HealthyHostCount', namespace: 'AWS/NetworkELB', label: 'Healthy hosts', unit: '', stat: 'Minimum', group: 'Errors', perTargetGroup: true, lowerIsWorse: true, alertCeiling: 1 },
]

const WAF: MetricDef[] = [
  { name: 'BlockedRequests', namespace: 'AWS/WAFV2', label: 'Blocked requests', unit: '/min', stat: 'Sum', group: 'Web ACL', primary: true, higherIsWorse: true },
  { name: 'AllowedRequests', namespace: 'AWS/WAFV2', label: 'Allowed requests', unit: '/min', stat: 'Sum', group: 'Web ACL', primary: true },
  { name: 'CountedRequests', namespace: 'AWS/WAFV2', label: 'Counted requests', unit: '/min', stat: 'Sum', group: 'Web ACL' },
]

const LAMBDA: MetricDef[] = [
  { name: 'Invocations', namespace: 'AWS/Lambda', label: 'Invocations', unit: '/min', stat: 'Sum', group: 'Core', primary: true },
  { name: 'Errors', namespace: 'AWS/Lambda', label: 'Errors', unit: '', stat: 'Sum', group: 'Core', primary: true, higherIsWorse: true, alertFloor: 5 },
  { name: 'Throttles', namespace: 'AWS/Lambda', label: 'Throttles', unit: '', stat: 'Sum', group: 'Core', higherIsWorse: true, alertFloor: 1 },
  { name: 'Duration', namespace: 'AWS/Lambda', label: 'Duration p95', unit: 'ms', stat: 'p95', group: 'Core', primary: true, higherIsWorse: true },
]

const SQS: MetricDef[] = [
  { name: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS', label: 'Messages visible', unit: '', stat: 'Average', group: 'Queue', primary: true },
  { name: 'ApproximateAgeOfOldestMessage', namespace: 'AWS/SQS', label: 'Age of oldest message', unit: 's', stat: 'Maximum', group: 'Queue', primary: true, higherIsWorse: true, alertFloor: 300 },
  { name: 'NumberOfMessagesSent', namespace: 'AWS/SQS', label: 'Messages sent', unit: '/min', stat: 'Sum', group: 'Queue' },
]

const ECS: MetricDef[] = [
  { name: 'CPUUtilization', namespace: 'AWS/ECS', label: 'Service CPU', unit: '%', stat: 'Average', group: 'Service', primary: true, higherIsWorse: true, alertFloor: 80, percent: true },
  { name: 'MemoryUtilization', namespace: 'AWS/ECS', label: 'Service memory', unit: '%', stat: 'Average', group: 'Service', primary: true, higherIsWorse: true, alertFloor: 85, percent: true },
]

const CLOUDFRONT: MetricDef[] = [
  { name: 'Requests', namespace: 'AWS/CloudFront', label: 'Requests', unit: '/min', stat: 'Sum', group: 'Distribution', primary: true },
  { name: '5xxErrorRate', namespace: 'AWS/CloudFront', label: '5xx error rate', unit: '%', stat: 'Average', group: 'Distribution', primary: true, higherIsWorse: true, alertFloor: 1, percent: true },
  { name: 'TotalErrorRate', namespace: 'AWS/CloudFront', label: 'Total error rate', unit: '%', stat: 'Average', group: 'Distribution', higherIsWorse: true, percent: true },
]

const S3: MetricDef[] = [
  { name: 'BucketSizeBytes', namespace: 'AWS/S3', label: 'Bucket size', unit: 'GB', scale: 1 / 1e9, stat: 'Average', group: 'Storage', primary: true },
  { name: 'AllRequests', namespace: 'AWS/S3', label: 'All requests', unit: '/min', stat: 'Sum', group: 'Storage', primary: true },
  { name: '4xxErrors', namespace: 'AWS/S3', label: '4xx errors', unit: '', stat: 'Sum', group: 'Storage', higherIsWorse: true },
]

const NETWORK_FIREWALL: MetricDef[] = [
  { name: 'DroppedPackets', namespace: 'AWS/NetworkFirewall', label: 'Dropped packets', unit: '/min', stat: 'Sum', group: 'Firewall', primary: true, higherIsWorse: true },
  { name: 'PassedPackets', namespace: 'AWS/NetworkFirewall', label: 'Passed packets', unit: '/min', stat: 'Sum', group: 'Firewall', primary: true },
]

export const METRIC_CATALOG: Partial<Record<NodeType, MetricDef[]>> = {
  rds: RDS,
  'rds-cluster': RDS,
  ec2: EC2,
  elasticache: ELASTICACHE,
  alb: ALB,
  nlb: NLB,
  'waf-web-acl': WAF,
  lambda: LAMBDA,
  sqs: SQS,
  'ecs-task': ECS,
  'ecs-service': ECS,
  cloudfront: CLOUDFRONT,
  s3: S3,
  'network-firewall': NETWORK_FIREWALL,
}

export function metricsFor(type: NodeType): MetricDef[] {
  return METRIC_CATALOG[type] ?? []
}

export function primaryMetricsFor(type: NodeType): MetricDef[] {
  return metricsFor(type).filter((m) => m.primary)
}

export function findMetricDef(type: NodeType, name: string): MetricDef | undefined {
  return metricsFor(type).find((m) => m.name === name)
}

/** A single metric's datapoints. Timestamps and values are index-aligned. */
export const metricSeriesSchema = z.object({
  nodeId: z.string(),
  metricName: z.string(),
  namespace: z.string(),
  label: z.string(),
  unit: z.string(),
  stat: metricStatSchema,
  /** Epoch ms, ascending. */
  timestamps: z.array(z.number()),
  /** Null for gaps — never silently zero-filled. */
  values: z.array(z.number().nullable()),
  /** Resolution in seconds. */
  period: z.number(),
  /** Set when CloudWatch returned nothing for this metric. */
  unavailableReason: z.string().nullable().default(null),
})
export type MetricSeries = z.infer<typeof metricSeriesSchema>

export const metricsRequestSchema = z.object({
  nodeId: z.string(),
  /** Empty means "the primary metrics for this node type". */
  metricNames: z.array(z.string()).default([]),
  /** Epoch ms. */
  start: z.number(),
  end: z.number(),
  /** Seconds. Server clamps to a CloudWatch-legal value. */
  period: z.number().optional(),
  stat: metricStatSchema.optional(),
})
export type MetricsRequest = z.infer<typeof metricsRequestSchema>

export const metricsResponseSchema = z.object({
  series: z.array(metricSeriesSchema),
  missingPermissions: z.array(z.string()).default([]),
})
export type MetricsResponse = z.infer<typeof metricsResponseSchema>

/** CloudWatch only accepts these periods (seconds) for GetMetricData. */
const LEGAL_PERIODS = [1, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400]

/**
 * Pick the finest legal period that keeps the point count under `maxPoints`.
 * CloudWatch also drops 1-minute resolution beyond 15 days of history.
 */
export function choosePeriod(startMs: number, endMs: number, maxPoints = 720): number {
  const spanSeconds = Math.max(60, (endMs - startMs) / 1000)
  const ageDays = (Date.now() - startMs) / 86_400_000
  const floor = ageDays > 63 ? 3600 : ageDays > 15 ? 300 : 60
  for (const p of LEGAL_PERIODS) {
    if (p < floor) continue
    if (spanSeconds / p <= maxPoints) return p
  }
  return 86_400
}

/** Human-readable value for a metric, respecting its unit. */
export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const n =
    abs >= 1000 ? Math.round(value).toLocaleString() : abs >= 10 ? value.toFixed(1) : value.toFixed(2)
  return unit ? `${n} ${unit}` : n
}


/**
 * Performance Insights: what a database was actually busy with.
 *
 * `db.load.avg` is measured in "average active sessions" — the mean number of
 * sessions running at once. Read against the instance's vCPU count it is the
 * one number that says whether a database is saturated: load above vCPUs means
 * sessions are queuing, whatever CPU utilisation happens to say.
 */
export const dbLoadItemSchema = z.object({
  /** SQL text or wait event name. */
  label: z.string(),
  /** Average active sessions attributed to this item. */
  load: z.number(),
  /** Share of total load, 0..1. */
  share: z.number(),
})
export type DbLoadItem = z.infer<typeof dbLoadItemSchema>

export const databaseLoadSchema = z.object({
  nodeId: z.string(),
  /** Average active sessions across the window. */
  averageLoad: z.number().nullable(),
  /** vCPUs, when known — the line above which sessions are queuing. */
  vcpus: z.number().nullable(),
  topSql: z.array(dbLoadItemSchema).default([]),
  topWaits: z.array(dbLoadItemSchema).default([]),
  /** Set when Performance Insights could not be queried, with the reason. */
  unavailableReason: z.string().nullable().default(null),
})
export type DatabaseLoad = z.infer<typeof databaseLoadSchema>
