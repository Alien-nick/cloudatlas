import { describe, expect, it } from 'vitest'
import type { Finding, GraphNode } from '@cloudatlas/shared'
import {
  blindSpots,
  coverage,
  findingsByKind,
  healthBreakdown,
  percent,
  rank,
  realResources,
} from './analytics'

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'n', arn: null, type: 'ec2', category: 'compute', name: 'n', abbr: 'E',
    typeLabel: 'EC2 instance', region: 'us-east-1', az: null, vpcId: 'vpc-1', subnetId: null,
    parentId: null, state: 'running', tags: [], props: [], raw: {}, logGroups: [],
    health: 'unknown', securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
    ...overrides,
  }
}

describe('what counts as a resource', () => {
  it('excludes containers and the synthetic internet node', () => {
    // Counting a VPC as a resource would inflate every denominator on the page.
    const nodes = [
      node({ id: 'vpc-1', type: 'vpc' }),
      node({ id: 'subnet-1', type: 'subnet' }),
      node({ id: 'az-1', type: 'az' }),
      node({ id: 'www', type: 'internet' }),
      node({ id: 'i-1', type: 'ec2' }),
    ]
    expect(realResources(nodes).map((entry) => entry.id)).toEqual(['i-1'])
  })
})

describe('coverage', () => {
  const nodes = [
    node({ id: 'i-1', type: 'ec2', health: 'ok' }),
    node({ id: 'i-2', type: 'ec2', logGroups: ['/aws/ec2/x'], health: 'warn' }),
    // A security group has no metric catalog entry and no logs.
    node({ id: 'sg-1', type: 'security-group', category: 'security' }),
    node({ id: 'vpc-1', type: 'vpc' }),
  ]

  it('reports each measure against every resource, not just the measurable ones', () => {
    const rows = coverage(nodes)
    const metrics = rows.find((row) => row.kind === 'metrics')
    // Three real resources; two of them have metrics. Reporting 2 of 2 by
    // quietly dropping the security group is the failure being prevented.
    expect(metrics?.total).toBe(3)
    expect(metrics?.covered).toBe(2)
  })

  it('counts unknown health as not assessed', () => {
    const assessed = coverage(nodes).find((row) => row.kind === 'health')
    // 'unknown' means nothing evaluated it, which is not the same as healthy.
    expect(assessed?.covered).toBe(2)
    expect(assessed?.total).toBe(3)
  })

  it('explains every gap in plain terms', () => {
    for (const row of coverage(nodes)) expect(row.gapReason.length).toBeGreaterThan(10)
  })
})

describe('ranking', () => {
  it('orders by count, breaking ties by label so a re-render is stable', () => {
    const nodes = [
      node({ id: '1', region: 'us-west-2' }),
      node({ id: '2', region: 'us-east-1' }),
      node({ id: '3', region: 'eu-west-1' }),
      node({ id: '4', region: 'eu-west-1' }),
    ]
    expect(rank(nodes, (entry) => entry.region).map((row) => row.key)).toEqual([
      'eu-west-1',
      'us-east-1',
      'us-west-2',
    ])
  })

  it('skips nodes the key does not apply to', () => {
    const nodes = [node({ id: '1', vpcId: 'vpc-1' }), node({ id: '2', vpcId: null })]
    expect(rank(nodes, (entry) => entry.vpcId)).toHaveLength(1)
  })
})

describe('health breakdown', () => {
  it('lists every state, including the ones at zero', () => {
    // "Not assessed" going unmentioned is how a dashboard implies everything
    // was checked when it was not.
    const rows = healthBreakdown([node({ id: 'i-1', health: 'ok' })])
    expect(rows.map((row) => row.state)).toEqual(['critical', 'warn', 'ok', 'unknown'])
    expect(rows.find((row) => row.state === 'unknown')?.count).toBe(0)
  })

  it('pairs each state with a glyph, so colour is never the only encoding', () => {
    for (const row of healthBreakdown([])) {
      expect(row.glyph.length).toBeGreaterThan(0)
      expect(row.label.length).toBeGreaterThan(0)
    }
  })
})

describe('blind spots', () => {
  it('names resources with neither metrics nor logs', () => {
    const nodes = [
      node({ id: 'i-1', type: 'ec2' }),
      node({ id: 'sg-1', type: 'security-group', category: 'security' }),
      node({ id: 'igw-1', type: 'internet-gateway', category: 'network' }),
    ]
    expect(blindSpots(nodes).map((entry) => entry.id)).toEqual(['igw-1', 'sg-1'])
  })

  it('does not list a resource that has logs but no metrics', () => {
    const nodes = [node({ id: 'sg-1', type: 'security-group', logGroups: ['/x'] })]
    expect(blindSpots(nodes)).toEqual([])
  })
})

describe('findings and percentages', () => {
  it('ranks finding kinds', () => {
    const findings = [
      { kind: 'imdsv1-allowed' },
      { kind: 'metric-spike' },
      { kind: 'metric-spike' },
    ] as Finding[]
    expect(findingsByKind(findings)[0]).toEqual({
      key: 'metric-spike',
      label: 'metric spike',
      count: 2,
    })
  })

  it('returns zero rather than NaN when there is nothing to divide', () => {
    expect(percent(0, 0)).toBe(0)
    expect(percent(1, 3)).toBe(33)
  })
})
