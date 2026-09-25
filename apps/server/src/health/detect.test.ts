import { describe, expect, it } from 'vitest'
import type { GetMetricDataOutput } from '@aws-sdk/client-cloudwatch'
import { primaryMetricsFor, type Graph, type GraphNode } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { DemoProvider } from '../providers/demo/index.js'
import { DEMO_EPOCH } from '../providers/demo/series.js'
import { detectSpikes } from './spike.js'
import { healthTargets, resolveLimits, runHealthPass } from './detect.js'

const MINUTE = 60_000

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'i-1',
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: 'web-1',
    abbr: 'EC2',
    typeLabel: 'EC2 instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: 'vpc-1',
    subnetId: 'subnet-1',
    parentId: 'subnet-1',
    state: 'running',
    tags: [],
    props: [],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
    ...overrides,
  }
}

function graphOf(nodes: GraphNode[]): Graph {
  return {
    nodes,
    edges: [],
    securityGroups: [],
    regions: [],
    missingPermissions: [],
    collectorFailures: [],
    scannedAt: Date.now(),
    accountId: '111122223333',
    accountAlias: null,
    profile: 'test',
  }
}

function stubClient(responses: Record<string, unknown> = {}): {
  aws: AwsClient
  calls: Array<{ operation: string; region: string; input: Record<string, unknown> }>
} {
  const calls: Array<{ operation: string; region: string; input: Record<string, unknown> }> = []
  const aws = {
    stats: { accessDenied: [] as string[] },
    async send(_service: string, region: string, operation: string, command: { input: Record<string, unknown> }) {
      calls.push({ operation, region, input: command.input })
      return (responses[operation] as GetMetricDataOutput) ?? {}
    },
    async collect() {
      return []
    },
  } as unknown as AwsClient
  return { aws, calls }
}

describe('choosing what to poll', () => {
  it('polls only node types the catalog has primary metrics for', () => {
    const targets = healthTargets([
      node({ id: 'i-1', type: 'ec2' }),
      node({ id: 'vpc-1', type: 'vpc' }),
      node({ id: 'subnet-1', type: 'subnet' }),
      node({ id: 'db-1', type: 'rds' }),
    ])
    expect(targets.map((t) => t.node.id)).toEqual(['i-1', 'db-1'])
    expect(targets[0]?.defs).toEqual(primaryMetricsFor('ec2'))
  })

  it('packs every node into as few CloudWatch calls as the limit allows', async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => node({ id: `i-${i}` }))
    const { aws, calls } = stubClient()

    await runHealthPass({ aws, graph: graphOf(nodes), now: Date.now() })

    const getMetricData = calls.filter((call) => call.operation === 'GetMetricData')
    // 40 nodes x 3 primary EC2 metrics = 120 queries, comfortably one call.
    expect(getMetricData).toHaveLength(1)
    expect((getMetricData[0]?.input.MetricDataQueries as unknown[]).length).toBe(120)
  })

  it('sends each region its own call', async () => {
    const nodes = [
      node({ id: 'i-east', region: 'us-east-1' }),
      node({ id: 'i-west', region: 'us-west-2' }),
    ]
    const { aws, calls } = stubClient()

    await runHealthPass({ aws, graph: graphOf(nodes), now: Date.now() })

    const regions = calls.filter((c) => c.operation === 'GetMetricData').map((c) => c.region)
    expect(new Set(regions)).toEqual(new Set(['us-east-1', 'us-west-2']))
  })

  it('makes no parameter-group calls for an account with no databases', async () => {
    const { aws } = stubClient()
    const limits = await resolveLimits(aws, [node({ type: 'ec2' })])
    expect(limits.size).toBe(0)
  })

  it('records why the limit is unknown when there is no parameter group', async () => {
    const { aws } = stubClient()
    const limits = await resolveLimits(aws, [node({ id: 'db-1', type: 'rds', raw: {} })])
    expect(limits.get('db-1')?.maxConnectionsUnknown).toMatch(/no parameter group/)
  })
})

/**
 * The demo series were written to tell a story, months before this detector
 * existed and without reference to how it works. That makes them the closest
 * thing to an independent fixture available before a real capture lands: if the
 * detector cannot find an incident a human deliberately staged, the thresholds
 * are wrong.
 */
describe('the detector against the demo narrative', () => {
  async function seriesFor(nodeId: string, metricNames: string[]) {
    const provider = new DemoProvider()
    const graph = await provider.scan({ profile: 'cortex-prod', regions: ['us-east-1'] })
    const target = graph.nodes.find((candidate) => candidate.id === nodeId)
    if (!target) throw new Error(`no node ${nodeId}`)
    const response = await provider.getMetrics({
      nodeId,
      metricNames,
      start: DEMO_EPOCH - 3 * 60 * MINUTE,
      end: DEMO_EPOCH,
    })
    return { node: target, series: response.series }
  }

  it('finds the staged RDS CPU spike', async () => {
    const { node: rds, series } = await seriesFor('rds-primary', ['CPUUtilization'])
    const findings = detectSpikes([{ node: rds, series }], { now: DEMO_EPOCH })

    expect(findings.map((f) => f.metric)).toContain('CPUUtilization')
    const cpu = findings.find((f) => f.metric === 'CPUUtilization')
    expect(cpu?.severity).toBe('critical')
    // The demo says the baseline is ~44% and the peak ~93%.
    expect(cpu?.evidence.join(' ')).toMatch(/9\d(\.\d)?\s*%/)
  })

  it('finds the staged connection spike and sizes it against max_connections', async () => {
    const { node: rds, series } = await seriesFor('rds-primary', ['DatabaseConnections'])
    const findings = detectSpikes([{ node: rds, series }], {
      now: DEMO_EPOCH,
      limits: new Map([['rds-primary', { maxConnections: 1600 }]]),
    })

    const connections = findings.find((f) => f.metric === 'DatabaseConnections')
    expect(connections).toBeDefined()
    expect(connections?.evidence.join(' | ')).toMatch(/of 1,600 max_connections/)
  })

  it('stays quiet on a database the demo did not stage an incident on', async () => {
    const { node: standby, series } = await seriesFor('rds-standby', [
      'CPUUtilization',
      'DatabaseConnections',
      'ReadLatency',
    ])
    expect(detectSpikes([{ node: standby, series }], { now: DEMO_EPOCH })).toEqual([])
  })
})
