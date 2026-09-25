import { z } from 'zod'

export const logSeveritySchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug'])
export type LogSeverity = z.infer<typeof logSeveritySchema>

export const logEventSchema = z.object({
  /** Stable id for list keys and "Ask Claude about this". */
  id: z.string(),
  /** Epoch ms. */
  timestamp: z.number(),
  message: z.string(),
  logGroup: z.string(),
  logStream: z.string(),
  /** Parsed from the message when recognisable. */
  severity: logSeveritySchema.nullable().default(null),
  /** Set when the message is valid JSON, for the expandable view. */
  json: z.unknown().optional(),
})
export type LogEvent = z.infer<typeof logEventSchema>

/** A log group attached to a node, with why we think it belongs there. */
export const logGroupRefSchema = z.object({
  name: z.string(),
  /** e.g. "RDS postgresql", "Lambda", "ECS awslogs", "VPC flow logs". */
  kind: z.string(),
  region: z.string(),
  /** False when the group is expected but not actually provisioned. */
  exists: z.boolean(),
  /** Shown when exists is false, e.g. "enable log exports on the instance". */
  hint: z.string().nullable().default(null),
  storedBytes: z.number().nullable().default(null),
})
export type LogGroupRef = z.infer<typeof logGroupRefSchema>

export const logQueryRequestSchema = z.object({
  logGroups: z.array(z.string()).min(1),
  region: z.string(),
  /** Epoch ms. */
  start: z.number(),
  end: z.number(),
  /** CloudWatch Logs filter pattern or plain substring. */
  filterPattern: z.string().default(''),
  limit: z.number().min(1).max(10_000).default(500),
})
export type LogQueryRequest = z.infer<typeof logQueryRequestSchema>

export const logQueryResponseSchema = z.object({
  events: z.array(logEventSchema),
  /** True when the limit cut the result short. */
  truncated: z.boolean().default(false),
  /** Per-minute counts for the histogram above the results. */
  histogram: z.array(z.object({ t: z.number(), count: z.number() })).default([]),
  missingPermissions: z.array(z.string()).default([]),
})
export type LogQueryResponse = z.infer<typeof logQueryResponseSchema>

export const insightsRequestSchema = z.object({
  logGroups: z.array(z.string()).min(1),
  region: z.string(),
  query: z.string().min(1),
  start: z.number(),
  end: z.number(),
  limit: z.number().min(1).max(10_000).default(1000),
})
export type InsightsRequest = z.infer<typeof insightsRequestSchema>

export const insightsResponseSchema = z.object({
  /** Column names in display order. */
  columns: z.array(z.string()),
  /** Each row maps column name to value. */
  rows: z.array(z.record(z.string(), z.string())),
  status: z.enum(['Complete', 'Running', 'Failed', 'Timeout', 'Cancelled']),
  statistics: z
    .object({
      recordsMatched: z.number(),
      recordsScanned: z.number(),
      bytesScanned: z.number(),
    })
    .nullable()
    .default(null),
  error: z.string().nullable().default(null),
})
export type InsightsResponse = z.infer<typeof insightsResponseSchema>

export interface InsightsTemplate {
  id: string
  label: string
  /** Which log-group kinds this template applies to. */
  appliesTo: string[]
  description: string
  query: string
}

export const INSIGHTS_TEMPLATES: InsightsTemplate[] = [
  {
    id: 'rds-slow-queries',
    label: 'Slowest queries',
    appliesTo: ['rds'],
    description: 'Longest-running statements from the Postgres slow query log.',
    query: `fields @timestamp, @message
| parse @message /duration: (?<durationMs>[0-9.]+) ms/
| filter ispresent(durationMs)
| sort durationMs desc
| limit 50`,
  },
  {
    id: 'rds-errors-by-minute',
    label: 'Error count by minute',
    appliesTo: ['rds'],
    description: 'ERROR and FATAL lines bucketed per minute.',
    query: `fields @timestamp, @message
| filter @message like /ERROR|FATAL/
| stats count(*) as errors by bin(1m)
| sort @timestamp desc`,
  },
  {
    id: 'rds-connection-errors',
    label: 'Connection slot exhaustion',
    appliesTo: ['rds'],
    description: 'Clients rejected because max_connections was reached.',
    query: `fields @timestamp, @message
| filter @message like /remaining connection slots|too many clients/
| stats count(*) as rejections by bin(1m)
| sort @timestamp desc`,
  },
  {
    id: 'waf-top-blocked-ips',
    label: 'Top blocked client IPs',
    appliesTo: ['waf'],
    description: 'Client IPs with the most BLOCK actions.',
    query: `fields httpRequest.clientIp as clientIp, action
| filter action = "BLOCK"
| stats count(*) as blocks by clientIp
| sort blocks desc
| limit 25`,
  },
  {
    id: 'waf-top-rules',
    label: 'Top terminating rules',
    appliesTo: ['waf'],
    description: 'Which rules are terminating the most requests.',
    query: `fields terminatingRuleId, action
| filter action = "BLOCK"
| stats count(*) as blocks by terminatingRuleId
| sort blocks desc
| limit 25`,
  },
  {
    id: 'waf-by-country',
    label: 'Blocks by country',
    appliesTo: ['waf'],
    description: 'Geographic distribution of blocked requests.',
    query: `fields httpRequest.country as country, action
| filter action = "BLOCK"
| stats count(*) as blocks by country
| sort blocks desc
| limit 25`,
  },
  {
    id: 'waf-top-uris',
    label: 'Top targeted URIs',
    appliesTo: ['waf'],
    description: 'Request paths attracting the most blocks.',
    query: `fields httpRequest.uri as uri, action
| filter action = "BLOCK"
| stats count(*) as blocks by uri
| sort blocks desc
| limit 25`,
  },
  {
    id: 'app-error-rate',
    label: 'Error rate by minute',
    appliesTo: ['ecs', 'lambda'],
    description: 'Application errors bucketed per minute.',
    query: `fields @timestamp, @message
| filter @message like /(?i)error|exception|traceback/
| stats count(*) as errors by bin(1m)
| sort @timestamp desc`,
  },
  {
    id: 'app-top-exceptions',
    label: 'Top exception messages',
    appliesTo: ['ecs', 'lambda'],
    description: 'Most frequent exception types in the window.',
    query: `fields @message
| filter @message like /(?i)exception|error/
| parse @message /(?<exception>[A-Za-z_.]*(?:Error|Exception))/
| filter ispresent(exception)
| stats count(*) as hits by exception
| sort hits desc
| limit 25`,
  },
  {
    id: 'lambda-duration',
    label: 'Duration and cold starts',
    appliesTo: ['lambda'],
    description: 'Billed duration and init duration per invocation.',
    query: `filter @type = "REPORT"
| stats avg(@duration) as avgMs, pct(@duration, 95) as p95Ms, max(@initDuration) as maxInitMs by bin(5m)
| sort @timestamp desc`,
  },
]

export function templatesForKinds(kinds: string[]): InsightsTemplate[] {
  const set = new Set(kinds)
  return INSIGHTS_TEMPLATES.filter((t) => t.appliesTo.some((k) => set.has(k)))
}

const SEVERITY_PATTERNS: Array<[LogSeverity, RegExp]> = [
  ['fatal', /\b(FATAL|PANIC|CRITICAL)\b/],
  ['error', /\b(ERROR|ERR|SEVERE|Exception|Traceback)\b/],
  ['warn', /\b(WARN|WARNING)\b/],
  ['info', /\b(INFO|NOTICE|LOG)\b/],
  ['debug', /\b(DEBUG|TRACE)\b/],
]

/** Best-effort severity extraction used for row highlighting. */
export function detectSeverity(message: string): LogSeverity | null {
  const head = message.slice(0, 400)
  for (const [severity, pattern] of SEVERITY_PATTERNS) {
    if (pattern.test(head)) return severity
  }
  return null
}

export const LOG_TIME_RANGES = [
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
] as const

export type LogTimeRangeId = (typeof LOG_TIME_RANGES)[number]['id']
