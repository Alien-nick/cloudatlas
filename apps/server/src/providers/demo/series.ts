import type { FindingKind, Severity } from '@cloudatlas/shared'

/**
 * Anchor for every synthetic incident. Fixed at process start so a running
 * session tells a stable story: the RDS spike stays where it was when you
 * opened the app instead of sliding around between polls.
 */
/**
 * Overridable so a test can pin it.
 *
 * The demo series are a pure function of absolute time, which includes a daily
 * cycle — so a value computed at 03:00 differs from the same offset computed at
 * 15:00. That is correct for the demo and poisonous for a test suite: anything
 * asserting on demo data silently depends on when it runs.
 */
function resolveDemoEpoch(): number {
  const override = Number(process.env.CLOUDATLAS_DEMO_EPOCH)
  if (Number.isFinite(override) && override > 0) return Math.floor(override / 60_000) * 60_000
  return Math.floor(Date.now() / 60_000) * 60_000
}

export const DEMO_EPOCH = resolveDemoEpoch()

const MINUTE = 60_000

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

function hashString(input: string): number {
  // FNV-1a
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Stable uniform value in [0, 1) for a string key. */
function unit(key: string): number {
  return hashString(key) / 0x100000000
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Value noise: smooth, repeatable, and a pure function of the timestamp. */
function valueNoise(seed: string, t: number, wavelengthMs: number): number {
  const x = t / wavelengthMs
  const i = Math.floor(x)
  const f = x - i
  const a = unit(`${seed}:${i}`)
  const b = unit(`${seed}:${i + 1}`)
  return a + (b - a) * smoothstep(f)
}

/** Three octaves of value noise, centred on 0, roughly in [-1, 1]. */
function fractalNoise(seed: string, t: number): number {
  const n =
    0.6 * valueNoise(seed, t, 47 * MINUTE) +
    0.3 * valueNoise(`${seed}#2`, t, 11 * MINUTE) +
    0.1 * valueNoise(`${seed}#3`, t, 3 * MINUTE)
  return (n - 0.5) * 2
}

/** Daily traffic shape: trough around 04:00 UTC, peak around 15:00 UTC. */
function dailyCycle(t: number): number {
  const dayFraction = (t % 86_400_000) / 86_400_000
  return Math.sin((dayFraction - 0.17) * Math.PI * 2)
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

interface Baseline {
  base: number
  /** Peak-to-trough noise amplitude. */
  swing: number
  min: number
  max: number
  /** How strongly the daily cycle modulates the value, as a fraction of base. */
  daily?: number
  integer?: boolean
}

const BY_METRIC: Record<string, Baseline> = {
  // RDS
  CPUUtilization: { base: 42, swing: 9, min: 0, max: 100, daily: 0.35 },
  DatabaseConnections: { base: 180, swing: 26, min: 4, max: 1600, daily: 0.4, integer: true },
  FreeableMemory: { base: 22, swing: 2.5, min: 0.4, max: 64 },
  ReadLatency: { base: 2.4, swing: 0.8, min: 0.2, max: 400 },
  WriteLatency: { base: 3.1, swing: 1.1, min: 0.2, max: 400 },
  ReadIOPS: { base: 3400, swing: 700, min: 0, max: 40000, daily: 0.4 },
  WriteIOPS: { base: 1250, swing: 340, min: 0, max: 40000, daily: 0.4 },
  DiskQueueDepth: { base: 1.2, swing: 0.6, min: 0, max: 120 },
  FreeStorageSpace: { base: 612, swing: 4, min: 1, max: 1024 },
  ReplicaLag: { base: 0.9, swing: 0.6, min: 0, max: 3600 },
  SwapUsage: { base: 0, swing: 0.2, min: 0, max: 8192 },
  BurstBalance: { base: 100, swing: 0, min: 0, max: 100 },

  // EC2
  StatusCheckFailed_Instance: { base: 0, swing: 0, min: 0, max: 1, integer: true },
  StatusCheckFailed_System: { base: 0, swing: 0, min: 0, max: 1, integer: true },
  NetworkIn: { base: 11.4, swing: 5.2, min: 0, max: 5000, daily: 0.5 },
  NetworkOut: { base: 8.1, swing: 4.4, min: 0, max: 5000, daily: 0.5 },
  EBSReadOps: { base: 420, swing: 180, min: 0, max: 50000 },
  EBSWriteOps: { base: 310, swing: 140, min: 0, max: 50000 },
  CPUCreditBalance: { base: 288, swing: 20, min: 0, max: 576 },
  mem_used_percent: { base: 63, swing: 7, min: 0, max: 100, daily: 0.15 },
  disk_used_percent: { base: 48, swing: 2, min: 1, max: 100 },

  // ElastiCache
  EngineCPUUtilization: { base: 27, swing: 8, min: 1, max: 100, daily: 0.4 },
  CurrConnections: { base: 96, swing: 22, min: 0, max: 65000, daily: 0.35, integer: true },
  Evictions: { base: 0, swing: 1.4, min: 0, max: 100000, integer: true },
  DatabaseMemoryUsagePercentage: { base: 58, swing: 5, min: 0, max: 100 },

  // ALB
  RequestCount: { base: 8400, swing: 1600, min: 0, max: 400000, daily: 0.55, integer: true },
  TargetResponseTime: { base: 0.094, swing: 0.022, min: 0.001, max: 60 },
  HTTPCode_Target_5XX_Count: { base: 1, swing: 2, min: 0, max: 100000, integer: true },
  HTTPCode_ELB_5XX_Count: { base: 0, swing: 1, min: 0, max: 100000, integer: true },
  UnHealthyHostCount: { base: 0, swing: 0, min: 0, max: 64, integer: true },

  // WAF
  BlockedRequests: { base: 126, swing: 48, min: 0, max: 2_000_000, daily: 0.4, integer: true },
  AllowedRequests: { base: 7900, swing: 900, min: 0, max: 2_000_000, daily: 0.55, integer: true },
  CountedRequests: { base: 340, swing: 90, min: 0, max: 2_000_000, integer: true },

  // Lambda
  Invocations: { base: 210, swing: 60, min: 0, max: 200000, daily: 0.5, integer: true },
  Errors: { base: 0, swing: 1.2, min: 0, max: 100000, integer: true },
  Throttles: { base: 0, swing: 0.3, min: 0, max: 100000, integer: true },
  Duration: { base: 412, swing: 90, min: 1, max: 900000 },

  // SQS
  ApproximateNumberOfMessagesVisible: { base: 34, swing: 18, min: 0, max: 500000, integer: true },
  ApproximateAgeOfOldestMessage: { base: 7, swing: 4, min: 0, max: 345600, integer: true },
  NumberOfMessagesSent: { base: 210, swing: 60, min: 0, max: 500000, daily: 0.5, integer: true },

  // ECS
  MemoryUtilization: { base: 61, swing: 8, min: 1, max: 100, daily: 0.2 },

  // CloudFront
  Requests: { base: 14200, swing: 2600, min: 0, max: 2_000_000, daily: 0.55, integer: true },
  '5xxErrorRate': { base: 0.12, swing: 0.09, min: 0, max: 100 },
  TotalErrorRate: { base: 1.4, swing: 0.5, min: 0, max: 100 },

  // S3
  BucketSizeBytes: { base: 412, swing: 3, min: 0, max: 1_000_000 },
  AllRequests: { base: 2600, swing: 700, min: 0, max: 5_000_000, daily: 0.5, integer: true },
  '4xxErrors': { base: 2, swing: 2, min: 0, max: 100000, integer: true },

  // Network Firewall
  DroppedPackets: { base: 18, swing: 12, min: 0, max: 5_000_000, integer: true },
  PassedPackets: { base: 96000, swing: 14000, min: 0, max: 50_000_000, daily: 0.5, integer: true },
}

/** Per-node overrides where the fixture's story needs a different scale. */
const BY_NODE_METRIC: Record<string, Partial<Baseline>> = {
  'rds-primary:CPUUtilization': { base: 44 },
  'rds-primary:DatabaseConnections': { base: 183 },
  'rds-standby:CPUUtilization': { base: 18, swing: 5 },
  'rds-standby:DatabaseConnections': { base: 41, swing: 9 },
  'dr-rds:CPUUtilization': { base: 9, swing: 3 },
  'dr-rds:DatabaseConnections': { base: 6, swing: 2 },
  'dr-rds:ReplicaLag': { base: 4.2, swing: 1.8 },
  'ec2-batch:CPUUtilization': { base: 31, swing: 12 },
  'redis:EngineCPUUtilization': { base: 27 },
  'dr-alb:RequestCount': { base: 120, swing: 40 },
  's3-uploads:BucketSizeBytes': { base: 88 },
  'dr-s3-backups:BucketSizeBytes': { base: 2150 },
  'eu-s3-assets:BucketSizeBytes': { base: 96 },
}

function baselineFor(nodeId: string, metricName: string): Baseline {
  const fallback: Baseline = { base: 10, swing: 3, min: 0, max: 1000 }
  const byMetric = BY_METRIC[metricName] ?? fallback
  const override = BY_NODE_METRIC[`${nodeId}:${metricName}`]
  return override ? { ...byMetric, ...override } : byMetric
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface DemoIncident {
  id: string
  nodeId: string
  kind: FindingKind
  severity: Severity
  title: string
  detail: string
  /** Metric that anchors the finding's sparkline. */
  metric: string | null
  /** Minutes before DEMO_EPOCH when the incident began. */
  startMinutesAgo: number
  /** Minutes before DEMO_EPOCH when it ended; null while still firing. */
  endMinutesAgo: number | null
  /** Target values while the incident is at full strength. */
  effects: Record<string, number>
  /** Ramp duration in minutes; 0 for a step change like a status check. */
  rampMinutes: number
  evidence: string[]
  logGroups: string[]
}

export const DEMO_INCIDENTS: DemoIncident[] = [
  {
    id: 'incident:rds-primary:cpu',
    nodeId: 'rds-primary',
    kind: 'metric-spike',
    severity: 'critical',
    title: 'prod-pg-primary CPU and connections spiking',
    detail:
      'CPU utilization moved from a 44% baseline to 93% and connections climbed from ~183 to ~1,420 ' +
      '(89% of the 1,600 max_connections limit). Read latency rose with it, which is the signature of ' +
      'connection pressure rather than a single heavy query.',
    metric: 'CPUUtilization',
    startMinutesAgo: 26,
    endMinutesAgo: null,
    effects: {
      CPUUtilization: 93,
      DatabaseConnections: 1420,
      ReadLatency: 34,
      WriteLatency: 41,
      DiskQueueDepth: 18,
      FreeableMemory: 3.1,
      ReadIOPS: 11200,
    },
    rampMinutes: 4,
    evidence: [
      'CPUUtilization 93.1% vs 44.0% baseline (robust z-score 11.8)',
      'DatabaseConnections 1,420 of 1,600 max_connections (89%)',
      'ReadLatency 34 ms vs 2.4 ms baseline (14x)',
      'DiskQueueDepth 18 vs 1.2 baseline',
    ],
    logGroups: ['/aws/rds/instance/prod-pg-primary/postgresql'],
  },
  {
    id: 'incident:waf:surge',
    nodeId: 'waf',
    kind: 'waf-surge',
    severity: 'critical',
    title: 'cortex-waf blocked-request surge',
    detail:
      'Blocked requests jumped from ~126/min to ~5,200/min. A single client IP (203.0.113.47) accounts ' +
      'for 61% of blocks, all terminated by the rate-limit rule against /api/v1/auth/login.',
    metric: 'BlockedRequests',
    startMinutesAgo: 47,
    endMinutesAgo: null,
    effects: {
      BlockedRequests: 5200,
      CountedRequests: 980,
    },
    rampMinutes: 6,
    evidence: [
      'BlockedRequests 5,200/min vs 126/min baseline (41x)',
      '203.0.113.47 responsible for 61% of blocks',
      'Terminating rule: rate-limit-login (2000 req / 5 min per IP)',
      'AllowedRequests unchanged at ~7,900/min — legitimate traffic is unaffected',
    ],
    logGroups: ['aws-waf-logs-cortex'],
  },
  {
    id: 'incident:ec2-batch:status-check',
    nodeId: 'ec2-batch',
    kind: 'status-check',
    severity: 'critical',
    title: 'batch-runner instance status check failing',
    detail:
      'StatusCheckFailed_Instance has been 1 for 9 minutes. CPU flatlined at the same moment, so the ' +
      'guest OS is not responding. The system status check is still passing, which points at the ' +
      'instance rather than the underlying host.',
    metric: 'StatusCheckFailed_Instance',
    startMinutesAgo: 9,
    endMinutesAgo: null,
    effects: {
      StatusCheckFailed_Instance: 1,
      CPUUtilization: 0.4,
      NetworkIn: 0.02,
      NetworkOut: 0.01,
      EBSReadOps: 0,
      EBSWriteOps: 0,
      mem_used_percent: 0,
    },
    rampMinutes: 0,
    evidence: [
      'StatusCheckFailed_Instance = 1 for 9 consecutive minutes',
      'StatusCheckFailed_System = 0 (underlying host is healthy)',
      'CPUUtilization dropped from 31% to 0.4% at the same timestamp',
      'No EBS read or write operations since the failure began',
    ],
    logGroups: [],
  },
  {
    id: 'incident:alb:5xx',
    nodeId: 'alb',
    kind: 'metric-spike',
    severity: 'warning',
    title: 'api-alb target 5XX elevated',
    detail:
      'Target 5XX responses rose to ~34/min and p95 target response time to 1.9s. The timing follows the ' +
      'prod-pg-primary connection spike, so this is most likely downstream saturation rather than an ALB fault.',
    metric: 'HTTPCode_Target_5XX_Count',
    startMinutesAgo: 22,
    endMinutesAgo: null,
    effects: {
      HTTPCode_Target_5XX_Count: 34,
      TargetResponseTime: 1.9,
    },
    rampMinutes: 5,
    evidence: [
      'HTTPCode_Target_5XX_Count 34/min vs 1/min baseline',
      'TargetResponseTime p95 1.9s vs 0.094s baseline',
      'UnHealthyHostCount still 0 — targets are responding, just slowly',
      'Onset trails the prod-pg-primary spike by 4 minutes',
    ],
    logGroups: ['/ecs/cortex-api'],
  },
]

export function incidentsForNode(nodeId: string): DemoIncident[] {
  return DEMO_INCIDENTS.filter((i) => i.nodeId === nodeId)
}

export function incidentWindow(incident: DemoIncident): { start: number; end: number | null } {
  return {
    start: DEMO_EPOCH - incident.startMinutesAgo * MINUTE,
    end: incident.endMinutesAgo === null ? null : DEMO_EPOCH - incident.endMinutesAgo * MINUTE,
  }
}

/** How strongly an incident is affecting a metric at time `t`, in [0, 1]. */
function incidentWeight(incident: DemoIncident, t: number): number {
  const { start, end } = incidentWindow(incident)
  if (t < start) return 0
  if (end !== null && t > end + incident.rampMinutes * MINUTE) return 0

  const rampMs = incident.rampMinutes * MINUTE
  const rising = rampMs === 0 ? 1 : Math.min(1, (t - start) / rampMs)
  if (end === null) return smoothstep(rising)

  const falling = rampMs === 0 ? (t > end ? 0 : 1) : Math.max(0, 1 - (t - end) / rampMs)
  return smoothstep(Math.min(rising, falling))
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Value of one metric at one timestamp. Pure — same inputs, same output. */
export function sampleMetric(nodeId: string, metricName: string, t: number): number {
  const baseline = baselineFor(nodeId, metricName)
  const seed = `${nodeId}|${metricName}`

  const daily = baseline.daily ? baseline.base * baseline.daily * dailyCycle(t) : 0
  const noise = fractalNoise(seed, t) * baseline.swing
  let value = baseline.base + daily + noise

  for (const incident of DEMO_INCIDENTS) {
    if (incident.nodeId !== nodeId) continue
    const target = incident.effects[metricName]
    if (target === undefined) continue
    const w = incidentWeight(incident, t)
    if (w === 0) continue
    // Blend toward the target and shrink the noise as the incident takes hold.
    const incidentNoise = fractalNoise(`${seed}|incident`, t) * baseline.swing * 0.35
    value = value * (1 - w) + (target + incidentNoise) * w
  }

  value = clamp(value, baseline.min, baseline.max)
  return baseline.integer ? Math.round(value) : Number(value.toFixed(4))
}

export interface SampledSeries {
  timestamps: number[]
  values: Array<number | null>
}

export function sampleSeries(
  nodeId: string,
  metricName: string,
  start: number,
  end: number,
  periodSeconds: number,
): SampledSeries {
  const step = periodSeconds * 1000
  const first = Math.ceil(start / step) * step
  const timestamps: number[] = []
  const values: Array<number | null> = []
  for (let t = first; t <= end; t += step) {
    timestamps.push(t)
    values.push(sampleMetric(nodeId, metricName, t))
  }
  return { timestamps, values }
}

/** Short series used for the sparkline on a finding card. */
export function sparklineFor(nodeId: string, metricName: string, points = 40): number[] {
  const step = 60_000
  const end = DEMO_EPOCH
  const out: number[] = []
  for (let i = points - 1; i >= 0; i--) {
    out.push(sampleMetric(nodeId, metricName, end - i * step))
  }
  return out
}
