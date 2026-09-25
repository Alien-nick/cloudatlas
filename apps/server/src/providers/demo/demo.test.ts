import { describe, expect, it } from 'vitest'
import { isContainerType, primaryMetricsFor } from '@cloudatlas/shared'
import { DemoProvider } from './index.js'
import { DEMO_EPOCH, sampleMetric, sampleSeries } from './series.js'

const MINUTE = 60_000

async function scanned(regions = ['us-east-1', 'us-west-2']) {
  const provider = new DemoProvider()
  const graph = await provider.scan({ profile: 'cortex-prod', regions })
  return { provider, graph }
}

describe('demo series', () => {
  it('is a pure function of the timestamp', () => {
    const t = DEMO_EPOCH - 12 * MINUTE
    const a = sampleMetric('rds-primary', 'CPUUtilization', t)
    const b = sampleMetric('rds-primary', 'CPUUtilization', t)
    expect(a).toBe(b)
  })

  it('gives different resources different values at the same instant', () => {
    const t = DEMO_EPOCH - 5 * MINUTE
    expect(sampleMetric('rds-primary', 'CPUUtilization', t)).not.toBe(
      sampleMetric('rds-standby', 'CPUUtilization', t),
    )
  })

  it('keeps values inside the metric bounds', () => {
    for (let i = 0; i < 400; i++) {
      const value = sampleMetric('rds-primary', 'CPUUtilization', DEMO_EPOCH - i * MINUTE)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  it('raises RDS CPU and connections inside the incident window only', () => {
    const before = sampleMetric('rds-primary', 'CPUUtilization', DEMO_EPOCH - 120 * MINUTE)
    const during = sampleMetric('rds-primary', 'CPUUtilization', DEMO_EPOCH)
    expect(before).toBeLessThan(70)
    expect(during).toBeGreaterThan(85)

    const connections = sampleMetric('rds-primary', 'DatabaseConnections', DEMO_EPOCH)
    expect(connections).toBeGreaterThan(1200)
  })

  it('surges WAF blocked requests without touching allowed requests', () => {
    expect(sampleMetric('waf', 'BlockedRequests', DEMO_EPOCH)).toBeGreaterThan(3000)
    expect(sampleMetric('waf', 'BlockedRequests', DEMO_EPOCH - 120 * MINUTE)).toBeLessThan(400)
    expect(sampleMetric('waf', 'AllowedRequests', DEMO_EPOCH)).toBeLessThan(20_000)
  })

  it('steps the EC2 instance status check to 1 and leaves the system check at 0', () => {
    expect(sampleMetric('ec2-batch', 'StatusCheckFailed_Instance', DEMO_EPOCH)).toBe(1)
    expect(sampleMetric('ec2-batch', 'StatusCheckFailed_Instance', DEMO_EPOCH - 30 * MINUTE)).toBe(0)
    expect(sampleMetric('ec2-batch', 'StatusCheckFailed_System', DEMO_EPOCH)).toBe(0)
  })

  it('samples on the requested period with aligned timestamps', () => {
    const end = DEMO_EPOCH
    const start = end - 60 * MINUTE
    const series = sampleSeries('rds-primary', 'CPUUtilization', start, end, 60)
    expect(series.timestamps.length).toBe(series.values.length)
    expect(series.timestamps.length).toBeGreaterThan(50)
    for (const t of series.timestamps) expect(t % 60_000).toBe(0)
  })
})

describe('demo scan', () => {
  it('produces a graph whose parents and edges all resolve', async () => {
    const { graph } = await scanned()
    const ids = new Set(graph.nodes.map((n) => n.id))

    for (const node of graph.nodes) {
      if (node.parentId !== null) expect(ids.has(node.parentId)).toBe(true)
    }
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })

  it('has no duplicate node ids', async () => {
    const { graph } = await scanned()
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length)
  })

  it('excludes regions the user did not select, but keeps global services', async () => {
    const { graph } = await scanned(['us-east-1'])
    const regions = new Set(graph.nodes.map((n) => n.region))
    expect(regions.has('us-west-2')).toBe(false)
    expect(regions.has('global')).toBe(true)
  })

  it('reports a resource count for every region, including empty ones', async () => {
    const { graph } = await scanned()
    const counts = Object.fromEntries(graph.regions.map((r) => [r.id, r.count]))
    expect(counts['us-east-1']).toBeGreaterThan(0)
    expect(counts['ap-southeast-2']).toBe(0)
  })

  it('derives the risky SSH rule and marks the affected node', async () => {
    const { graph } = await scanned()
    const risk = graph.edges.filter((e) => e.kind === 'risk')
    expect(risk).toHaveLength(1)
    expect(risk[0]?.target).toBe('ec2-legacy')
    expect(graph.nodes.find((n) => n.id === 'ec2-legacy')?.health).toBe('warn')
  })

  it('marks the incident nodes critical and the rest ok', async () => {
    const { graph } = await scanned()
    const critical = graph.nodes.filter((n) => n.health === 'critical').map((n) => n.id).sort()
    expect(critical).toEqual(['ec2-batch', 'rds-primary', 'waf'])
    expect(graph.nodes.find((n) => n.id === 'redis')?.health).toBe('ok')
  })

  it('never marks a container node', async () => {
    const { graph } = await scanned()
    for (const node of graph.nodes.filter((n) => isContainerType(n.type))) {
      expect(node.health).toBe('unknown')
    }
  })

  it('marks public subnets by their route to an internet gateway', async () => {
    const { graph } = await scanned()
    const subnets = graph.nodes.filter((n) => n.type === 'subnet')
    expect(subnets.some((s) => s.isPublic === true)).toBe(true)
    expect(subnets.some((s) => s.isPublic === false)).toBe(true)
  })
})

describe('demo provider surface', () => {
  it('returns the primary metrics for a node type', async () => {
    const { provider } = await scanned()
    const end = Date.now()
    const response = await provider.getMetrics({
      nodeId: 'rds-primary',
      metricNames: [],
      start: end - 60 * MINUTE,
      end,
    })
    expect(response.series.map((s) => s.metricName)).toEqual(
      primaryMetricsFor('rds').map((m) => m.name),
    )
  })

  it('explains why a stopped instance has no datapoints instead of showing zeros', async () => {
    const { provider } = await scanned()
    const end = Date.now()
    const response = await provider.getMetrics({
      nodeId: 'ec2-legacy',
      metricNames: ['CPUUtilization'],
      start: end - 60 * MINUTE,
      end,
    })
    expect(response.series[0]?.unavailableReason).toMatch(/stopped/i)
    expect(response.series[0]?.values).toEqual([])
  })

  it('explains that CPU credits need a burstable instance type', async () => {
    const { provider } = await scanned()
    const end = Date.now()
    const response = await provider.getMetrics({
      nodeId: 'ec2-batch',
      metricNames: ['CPUCreditBalance'],
      start: end - 60 * MINUTE,
      end,
    })
    expect(response.series[0]?.unavailableReason).toMatch(/burstable/i)
  })

  it('surfaces a log group that exists and one that needs enabling', async () => {
    const { provider } = await scanned()
    const groups = await provider.listLogGroups('rds-primary')
    expect(groups.some((g) => g.exists)).toBe(true)
    const missing = groups.find((g) => !g.exists)
    expect(missing?.hint).toMatch(/log export/i)
  })

  it('says ALB access logs go to S3 rather than showing an empty picker', async () => {
    const { provider } = await scanned()
    const groups = await provider.listLogGroups('alb')
    expect(groups[0]?.hint).toMatch(/S3/)
  })

  it('returns deterministic log events for a window', async () => {
    const { provider } = await scanned()
    const request = {
      logGroups: ['/aws/rds/instance/prod-pg-primary/postgresql'],
      region: 'us-east-1',
      start: DEMO_EPOCH - 10 * MINUTE,
      end: DEMO_EPOCH,
      filterPattern: '',
      limit: 200,
    }
    const first = await provider.queryLogs(request)
    const second = await provider.queryLogs(request)
    expect(first.events.map((e) => e.id)).toEqual(second.events.map((e) => e.id))
    expect(first.events.length).toBeGreaterThan(0)
  })

  it('shows connection-slot failures in the RDS log during the incident', async () => {
    const { provider } = await scanned()
    const response = await provider.queryLogs({
      logGroups: ['/aws/rds/instance/prod-pg-primary/postgresql'],
      region: 'us-east-1',
      start: DEMO_EPOCH - 15 * MINUTE,
      end: DEMO_EPOCH,
      filterPattern: '',
      limit: 500,
    })
    expect(response.events.some((e) => e.severity === 'fatal')).toBe(true)
    expect(response.events.some((e) => e.message.includes('remaining connection slots'))).toBe(true)
  })

  it('honours a filter pattern', async () => {
    const { provider } = await scanned()
    const response = await provider.queryLogs({
      logGroups: ['aws-waf-logs-cortex'],
      region: 'us-east-1',
      start: DEMO_EPOCH - 10 * MINUTE,
      end: DEMO_EPOCH,
      filterPattern: 'BLOCK',
      limit: 200,
    })
    expect(response.events.length).toBeGreaterThan(0)
    expect(response.events.every((e) => e.message.includes('BLOCK'))).toBe(true)
  })

  it('parses JSON log lines so the UI can expand them', async () => {
    const { provider } = await scanned()
    const response = await provider.queryLogs({
      logGroups: ['aws-waf-logs-cortex'],
      region: 'us-east-1',
      start: DEMO_EPOCH - 5 * MINUTE,
      end: DEMO_EPOCH,
      filterPattern: '',
      limit: 50,
    })
    expect(response.events[0]?.json).toBeTypeOf('object')
  })

  it('maps firing alarms back to graph nodes', async () => {
    const { provider } = await scanned()
    const alarms = await provider.getAlarms('ALARM')
    expect(alarms.length).toBeGreaterThan(0)
    expect(alarms.every((a) => a.state === 'ALARM')).toBe(true)
    expect(alarms.map((a) => a.nodeId)).toContain('rds-primary')
  })

  it('aggregates WAF samples by rule, IP, country and URI', async () => {
    const { provider } = await scanned()
    const result = await provider.getWafSampled({
      webAclNodeId: 'waf',
      start: DEMO_EPOCH - 30 * MINUTE,
      end: DEMO_EPOCH,
    })
    expect(result.requests.length).toBeGreaterThan(0)
    expect(result.byClientIp[0]?.key).toBe('203.0.113.47')
    expect(result.byRule[0]?.key).toBe('rate-limit-login')
  })

  it('returns findings for every injected incident plus the SG risk', async () => {
    const { provider } = await scanned()
    const findings = await provider.getFindings()
    const kinds = findings.map((f) => f.kind)
    expect(kinds).toContain('metric-spike')
    expect(kinds).toContain('waf-surge')
    expect(kinds).toContain('status-check')
    expect(kinds).toContain('risky-sg-rule')
  })

  it('scopes recent changes to the requested window', async () => {
    const { provider } = await scanned()
    const changes = await provider.getRecentChanges(DEMO_EPOCH - 60 * MINUTE, DEMO_EPOCH)
    expect(changes.length).toBeGreaterThan(0)
    for (const change of changes) {
      expect(change.timestamp).toBeGreaterThanOrEqual(DEMO_EPOCH - 60 * MINUTE)
      expect(change.timestamp).toBeLessThanOrEqual(DEMO_EPOCH)
    }
  })

  it('streams scan progress for every region and finishes at 100%', async () => {
    const provider = new DemoProvider()
    const seen = new Map<string, string[]>()
    await provider.scan({
      profile: 'cortex-prod',
      regions: ['us-east-1', 'eu-west-1'],
      onProgress: (p) => {
        const list = seen.get(p.region) ?? []
        list.push(p.state)
        seen.set(p.region, list)
      },
    })
    expect([...seen.keys()].sort()).toEqual(['eu-west-1', 'us-east-1'])
    for (const states of seen.values()) {
      expect(states[0]).toBe('queued')
      expect(states.at(-1)).toBe('done')
    }
  })
})
