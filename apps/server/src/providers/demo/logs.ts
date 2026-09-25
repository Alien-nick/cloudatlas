import { detectSeverity, type LogEvent } from '@cloudatlas/shared'
import { DEMO_EPOCH, DEMO_INCIDENTS, incidentWindow } from './series.js'

const MINUTE = 60_000
/** Upper bound on synthesised events per query, so a 24h window stays cheap. */
const MAX_GENERATED = 50_000

type GroupKind = 'rds' | 'ecs' | 'lambda' | 'waf' | 'firewall' | 'flowlog' | 'generic'

export function logGroupKind(logGroup: string): GroupKind {
  if (logGroup.startsWith('/aws/rds/')) return 'rds'
  if (logGroup.startsWith('/ecs/')) return 'ecs'
  if (logGroup.startsWith('/aws/lambda/')) return 'lambda'
  if (logGroup.startsWith('aws-waf-logs-')) return 'waf'
  if (logGroup.startsWith('/aws/network-firewall/')) return 'firewall'
  if (logGroup.includes('flowlogs')) return 'flowlog'
  return 'generic'
}

/** Which node's incidents colour the contents of a log group. */
const GROUP_NODE: Record<string, string> = {
  '/aws/rds/instance/prod-pg-primary/postgresql': 'rds-primary',
  '/aws/rds/instance/prod-pg-standby/postgresql': 'rds-standby',
  '/aws/rds/instance/dr-pg-replica/postgresql': 'dr-rds',
  '/ecs/cortex-api': 'alb',
  'aws-waf-logs-cortex': 'waf',
}

function hash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function unit(key: string): number {
  return hash(key) / 0x100000000
}

function pick<T>(items: readonly T[], key: string): T {
  const index = Math.floor(unit(key) * items.length)
  // Guarded because noUncheckedIndexedAccess makes the index access optional.
  return items[Math.min(index, items.length - 1)] as T
}

/** Fraction of incident intensity affecting this group at time t, in [0, 1]. */
function incidentIntensity(logGroup: string, t: number): number {
  const nodeId = GROUP_NODE[logGroup]
  if (!nodeId) return 0
  let max = 0
  for (const incident of DEMO_INCIDENTS) {
    if (incident.nodeId !== nodeId) continue
    const { start, end } = incidentWindow(incident)
    if (t < start) continue
    if (end !== null && t > end) continue
    const ramp = incident.rampMinutes * MINUTE
    max = Math.max(max, ramp === 0 ? 1 : Math.min(1, (t - start) / ramp))
  }
  return max
}

const BASE_RATE: Record<GroupKind, number> = {
  rds: 4,
  ecs: 18,
  lambda: 6,
  waf: 12,
  firewall: 3,
  flowlog: 22,
  generic: 5,
}

const PG_USERS = ['cortex_api', 'cortex_batch', 'readonly_bi', 'postgres']
const PG_QUERIES = [
  'SELECT p.id, p.mrn, p.given_name FROM patients p WHERE p.facility_id = $1 ORDER BY p.updated_at DESC LIMIT 50',
  'UPDATE encounters SET status = $1, updated_at = now() WHERE id = $2',
  'SELECT count(*) FROM lab_results WHERE collected_at >= $1 AND facility_id = $2',
  'INSERT INTO audit_log (actor, action, entity, payload) VALUES ($1, $2, $3, $4)',
  'SELECT * FROM appointments WHERE clinician_id = $1 AND starts_at BETWEEN $2 AND $3',
]
const HTTP_PATHS = [
  '/api/v1/patients',
  '/api/v1/encounters',
  '/api/v1/lab-results',
  '/api/v1/appointments',
  '/healthz',
]
const CLIENT_IPS = ['198.51.100.23', '203.0.113.47', '192.0.2.88', '198.51.100.91', '203.0.113.12']
const COUNTRIES = ['GY', 'US', 'TT', 'BR', 'RU', 'KP']
const WAF_RULES = [
  'rate-limit-login',
  'AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY',
  'AWSManagedRulesSQLiRuleSet/SQLi_QUERYARGUMENTS',
  'geo-block-high-risk',
]

function pgMessage(t: number, key: string, intensity: number): string {
  const iso = new Date(t).toISOString().replace('T', ' ').replace('Z', ' UTC')
  const pid = 12000 + Math.floor(unit(`${key}:pid`) * 8000)
  const user = pick(PG_USERS, `${key}:user`)
  const roll = unit(`${key}:roll`)

  if (intensity > 0 && roll < 0.35 * intensity + 0.02) {
    return `${iso} [${pid}] FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute`
  }
  if (intensity > 0 && roll < 0.55 * intensity + 0.04) {
    const waitMs = (2200 + unit(`${key}:wait`) * 9000).toFixed(3)
    return `${iso} [${pid}] LOG:  duration: ${waitMs} ms  statement: ${pick(PG_QUERIES, `${key}:q`)}`
  }
  if (roll < 0.06) {
    return `${iso} [${pid}] ERROR:  deadlock detected\n\tDETAIL:  Process ${pid} waits for ShareLock on transaction ${400000 + Math.floor(unit(`${key}:tx`) * 90000)}`
  }
  if (roll < 0.2) {
    const durationMs = (12 + unit(`${key}:d`) * 340).toFixed(3)
    return `${iso} [${pid}] LOG:  duration: ${durationMs} ms  statement: ${pick(PG_QUERIES, `${key}:q`)}`
  }
  return `${iso} [${pid}] LOG:  connection authorized: user=${user} database=cortex SSL enabled (protocol=TLSv1.3)`
}

function ecsMessage(t: number, key: string, intensity: number): string {
  const iso = new Date(t).toISOString()
  const path = pick(HTTP_PATHS, `${key}:path`)
  const requestId = hash(`${key}:rid`).toString(16).padStart(8, '0')
  const roll = unit(`${key}:roll`)

  if (intensity > 0 && roll < 0.3 * intensity + 0.01) {
    return JSON.stringify({
      level: 'ERROR',
      ts: iso,
      requestId,
      msg: 'upstream database error',
      path,
      status: 500,
      durationMs: Math.round(1800 + unit(`${key}:d`) * 4200),
      error: 'sqlalchemy.exc.OperationalError: FATAL: remaining connection slots are reserved',
    })
  }
  if (roll < 0.04) {
    return JSON.stringify({
      level: 'WARN',
      ts: iso,
      requestId,
      msg: 'slow request',
      path,
      status: 200,
      durationMs: Math.round(900 + unit(`${key}:d`) * 1200),
    })
  }
  return JSON.stringify({
    level: 'INFO',
    ts: iso,
    requestId,
    msg: 'request completed',
    method: roll < 0.7 ? 'GET' : 'POST',
    path,
    status: 200,
    durationMs: Math.round(24 + unit(`${key}:d`) * 180),
  })
}

function lambdaMessage(t: number, key: string): string {
  const iso = new Date(t).toISOString()
  const requestId = `${hash(`${key}:a`).toString(16)}-${hash(`${key}:b`).toString(16).slice(0, 4)}`
  const roll = unit(`${key}:roll`)
  if (roll < 0.05) {
    return `${iso}\t${requestId}\tERROR\tPillow.UnidentifiedImageError: cannot identify image file '/tmp/upload-${hash(key) % 9999}.bin'`
  }
  if (roll < 0.18) {
    const duration = (180 + unit(`${key}:d`) * 900).toFixed(2)
    return `REPORT RequestId: ${requestId}\tDuration: ${duration} ms\tBilled Duration: ${Math.ceil(Number(duration))} ms\tMemory Size: 1024 MB\tMax Memory Used: ${Math.round(180 + unit(`${key}:m`) * 400)} MB`
  }
  return `${iso}\t${requestId}\tINFO\tresized s3://prod-uploads/scan-${hash(key) % 99999}.jpg -> 3 variants in ${Math.round(120 + unit(`${key}:d`) * 400)}ms`
}

function wafMessage(t: number, key: string, intensity: number): string {
  const attack = intensity > 0 && unit(`${key}:atk`) < 0.75 * intensity
  const blocked = attack || unit(`${key}:blk`) < 0.14
  const clientIp = attack ? '203.0.113.47' : pick(CLIENT_IPS, `${key}:ip`)
  const country = attack ? 'RU' : pick(COUNTRIES, `${key}:cc`)
  const rule = attack ? 'rate-limit-login' : pick(WAF_RULES, `${key}:rule`)
  return JSON.stringify({
    timestamp: t,
    webaclId: `arn:aws:wafv2:us-east-1:482177301192:global/webacl/cortex-waf/8f21a3c4`,
    terminatingRuleId: blocked ? rule : 'Default_Action',
    action: blocked ? 'BLOCK' : 'ALLOW',
    httpRequest: {
      clientIp,
      country,
      uri: attack ? '/api/v1/auth/login' : pick(HTTP_PATHS, `${key}:uri`),
      httpMethod: attack ? 'POST' : 'GET',
      headers: [{ name: 'user-agent', value: attack ? 'python-requests/2.31.0' : 'Mozilla/5.0' }],
    },
  })
}

function firewallMessage(t: number, key: string): string {
  const action = unit(`${key}:a`) < 0.3 ? 'drop' : unit(`${key}:a`) < 0.4 ? 'alert' : 'pass'
  return JSON.stringify({
    firewall_name: 'prod-netfw',
    availability_zone: unit(`${key}:az`) < 0.5 ? 'us-east-1a' : 'us-east-1b',
    event_timestamp: Math.floor(t / 1000),
    event: {
      src_ip: pick(CLIENT_IPS, `${key}:src`),
      src_port: 1024 + Math.floor(unit(`${key}:sp`) * 60000),
      dest_ip: '10.0.11.41',
      dest_port: 443,
      proto: 'TCP',
      alert: { action, signature: action === 'pass' ? 'tls-sni-allowlist' : 'threat-intel-feed' },
    },
  })
}

function flowlogMessage(t: number, key: string): string {
  const srcIp = pick(CLIENT_IPS, `${key}:src`)
  const bytes = Math.round(400 + unit(`${key}:b`) * 40000)
  const action = unit(`${key}:a`) < 0.05 ? 'REJECT' : 'ACCEPT'
  return `2 482177301192 eni-0c41aa93 ${srcIp} 10.0.11.41 ${1024 + Math.floor(unit(`${key}:sp`) * 60000)} 8080 6 ${Math.round(4 + unit(`${key}:p`) * 60)} ${bytes} ${Math.floor(t / 1000) - 60} ${Math.floor(t / 1000)} ${action} OK`
}

function streamName(kind: GroupKind, t: number, key: string): string {
  const date = new Date(t).toISOString().slice(0, 10)
  switch (kind) {
    case 'ecs':
      return `cortex-api/api/${hash(`${key}:s`).toString(16).slice(0, 8)}`
    case 'lambda':
      return `${date}/[$LATEST]${hash(`${key}:s`).toString(16).padStart(8, '0')}`
    case 'rds':
      return `prod-pg-primary.0`
    case 'waf':
      return `cortex-waf_${date}`
    default:
      return `${date}-${hash(`${key}:s`) % 1000}`
  }
}

function renderMessage(kind: GroupKind, t: number, key: string, intensity: number): string {
  switch (kind) {
    case 'rds':
      return pgMessage(t, key, intensity)
    case 'ecs':
      return ecsMessage(t, key, intensity)
    case 'lambda':
      return lambdaMessage(t, key)
    case 'waf':
      return wafMessage(t, key, intensity)
    case 'firewall':
      return firewallMessage(t, key)
    case 'flowlog':
      return flowlogMessage(t, key)
    case 'generic':
      return `${new Date(t).toISOString()} INFO  heartbeat ok`
  }
}

function parseJson(message: string): unknown {
  const trimmed = message.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function matches(message: string, pattern: string): boolean {
  if (!pattern) return true
  const trimmed = pattern.trim()
  // CloudWatch quoted-term syntax, e.g. ?ERROR "connection"
  const quoted = /^"(.*)"$/.exec(trimmed)
  const needle = (quoted?.[1] ?? trimmed).toLowerCase()
  return message.toLowerCase().includes(needle)
}

export interface GeneratedLogs {
  events: LogEvent[]
  truncated: boolean
  histogram: Array<{ t: number; count: number }>
}

/**
 * Synthesise the contents of a log group for a window. Deterministic: the same
 * window always produces the same lines, so scrolling back and forth is stable
 * and a finding's correlated logs stay put.
 */
export function generateLogEvents(
  logGroup: string,
  start: number,
  end: number,
  filterPattern: string,
  limit: number,
): GeneratedLogs {
  const kind = logGroupKind(logGroup)
  const baseRate = BASE_RATE[kind]

  const firstMinute = Math.floor(start / MINUTE)
  const lastMinute = Math.floor(Math.min(end, DEMO_EPOCH + MINUTE) / MINUTE)
  const minuteCount = Math.max(0, lastMinute - firstMinute + 1)
  if (minuteCount === 0) return { events: [], truncated: false, histogram: [] }

  // Keep the total bounded no matter how wide the window is.
  const rate = Math.max(1, Math.min(baseRate, Math.floor(MAX_GENERATED / minuteCount)))

  const histogram: Array<{ t: number; count: number }> = []
  const collected: LogEvent[] = []
  let truncated = false

  // Walk backwards from the newest minute so `limit` keeps the most recent lines.
  for (let m = lastMinute; m >= firstMinute; m--) {
    const minuteStart = m * MINUTE
    const intensity = incidentIntensity(logGroup, minuteStart)
    const surge = kind === 'waf' || kind === 'ecs' ? 1 + intensity * 3 : 1
    const count = Math.max(1, Math.round(rate * surge))

    let minuteMatches = 0
    for (let i = 0; i < count; i++) {
      const key = `${logGroup}|${m}|${i}`
      const t = minuteStart + Math.floor(unit(`${key}:off`) * MINUTE)
      if (t < start || t > end) continue
      const message = renderMessage(kind, t, key, intensity)
      if (!matches(message, filterPattern)) continue
      minuteMatches++
      if (collected.length < limit) {
        collected.push({
          id: `${logGroup}:${m}:${i}`,
          timestamp: t,
          message,
          logGroup,
          logStream: streamName(kind, t, key),
          severity: detectSeverity(message),
          json: parseJson(message),
        })
      } else {
        truncated = true
      }
    }
    histogram.push({ t: minuteStart, count: minuteMatches })
  }

  histogram.reverse()
  collected.sort((a, b) => a.timestamp - b.timestamp)
  return { events: collected, truncated, histogram }
}

/** One batch of brand-new lines, for the live-tail stream. */
export function generateTailBatch(logGroup: string, since: number, until: number): LogEvent[] {
  if (until <= since) return []
  const { events } = generateLogEvents(logGroup, since, until, '', 200)
  return events
}
