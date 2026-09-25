import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import { rankResources, scoreNode } from './palette'

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'i-1', arn: null, type: 'ec2', category: 'compute', name: 'web', abbr: 'E',
    typeLabel: 'EC2 instance', region: 'us-east-1', az: null, vpcId: null, subnetId: null,
    parentId: null, state: 'running', tags: [], props: [], raw: {}, logGroups: [],
    health: 'unknown', securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
    ...overrides,
  }
}

describe('ranking', () => {
  it('puts an exact name above a prefix above a substring', () => {
    const exact = node({ name: 'api' })
    const prefix = node({ name: 'api-gateway' })
    const substring = node({ name: 'internal-api-v2' })
    expect(scoreNode(exact, 'api')).toBeGreaterThan(scoreNode(prefix, 'api')!)
    expect(scoreNode(prefix, 'api')).toBeGreaterThan(scoreNode(substring, 'api')!)
  })

  it('matches id, type and tags, but ranks them below the name', () => {
    const byName = node({ name: 'cortex' })
    const byId = node({ name: 'other', id: 'i-cortex-1' })
    const byType = node({ name: 'other', id: 'x', type: 'rds', typeLabel: 'RDS instance' })
    const byTag = node({ name: 'other', id: 'x', tags: [{ key: 'Service', value: 'cortex' }] })

    expect(scoreNode(byName, 'cortex')).toBeGreaterThan(scoreNode(byId, 'cortex')!)
    expect(scoreNode(byId, 'cortex')).toBeGreaterThan(scoreNode(byTag, 'cortex')!)
    expect(scoreNode(byType, 'rds')).toBeGreaterThan(0)
  })

  it('returns null for no match at all', () => {
    expect(scoreNode(node({ name: 'web' }), 'zzz')).toBeNull()
  })

  it('finds the exact name first even when many others contain it', () => {
    // The failure that makes a palette useless: typing a full resource name
    // and finding it third.
    const nodes = [
      node({ id: 'a', name: 'prod-db-replica-1' }),
      node({ id: 'b', name: 'prod-db-replica-2' }),
      node({ id: 'c', name: 'prod-db' }),
      node({ id: 'd', name: 'staging-prod-db-copy' }),
    ]
    expect(rankResources(nodes, 'prod-db')[0]?.id).toBe('c')
  })

  it('excludes containers, which are navigation rather than destinations', () => {
    const nodes = [
      node({ id: 'vpc-1', name: 'prod-vpc', type: 'vpc' }),
      node({ id: 'subnet-1', name: 'prod-subnet', type: 'subnet' }),
      node({ id: 'i-1', name: 'prod-web', type: 'ec2' }),
      node({ id: 'www', name: '0.0.0.0/0', type: 'internet' }),
    ]
    expect(rankResources(nodes, 'prod').map((n) => n.id)).toEqual(['i-1'])
  })

  it('returns everything for an empty query, capped', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => node({ id: `i-${i}`, name: `n${i}` }))
    expect(rankResources(nodes, '')).toHaveLength(20)
    expect(rankResources(nodes, '', 5)).toHaveLength(5)
  })

  it('breaks ties by name so the order is stable', () => {
    const nodes = [node({ id: 'b', name: 'beta' }), node({ id: 'a', name: 'alpha' })]
    expect(rankResources(nodes, '').map((n) => n.name)).toEqual(['alpha', 'beta'])
  })
})
