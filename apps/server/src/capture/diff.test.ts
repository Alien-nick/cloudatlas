import { describe, expect, it } from 'vitest'
import type { Graph, GraphEdge, GraphNode, PropEntry } from '@cloudatlas/shared'
import { attribute, diffGraphs } from './diff.js'
import { normalizeUnstable, onlyIdsDiffer } from './fingerprint.js'

function node(patch: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: 'res-1',
    abbr: 'EC2',
    typeLabel: 'EC2 instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: null,
    subnetId: null,
    parentId: null,
    state: 'running',
    tags: [],
    props: [],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
    ...patch,
  }
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): Graph {
  return {
    nodes,
    edges,
    securityGroups: [],
    regions: [],
    missingPermissions: [],
    collectorFailures: [],
    scannedAt: 0,
    accountId: '111122223333',
    accountAlias: null,
    profile: 'p',
  }
}

const prop = (k: string, v: string): PropEntry => ({ k, v, mono: true })

describe('normalizeUnstable', () => {
  it('canonicalises resource ids, placeholders and account ids', () => {
    expect(normalizeUnstable('i-0000000001')).toBe('i-<id>')
    expect(normalizeUnstable('res-7')).toBe('res-<n>')
    expect(normalizeUnstable('482177301192')).toBe('<account>')
    expect(normalizeUnstable('/redacted/lg-3')).toBe('/redacted/lg-<n>')
  })

  it('normalises ids embedded in a longer value, keeping the rest', () => {
    expect(normalizeUnstable('vol-0000000001 80 GiB gp3')).toBe('vol-<id> 80 GiB gp3')
  })

  it('leaves genuinely stable values alone', () => {
    for (const value of ['m6i.xlarge', '10.0.11.41', 'us-east-1a', '0.0.0.0/0', 'postgres 15.4']) {
      expect(normalizeUnstable(value)).toBe(value)
    }
  })
})

describe('onlyIdsDiffer', () => {
  it('is true when two values differ only in their fakes', () => {
    expect(onlyIdsDiffer('i-0000000001', 'i-0000000091')).toBe(true)
    expect(onlyIdsDiffer('vol-0000000001 80 GiB gp3', 'vol-0000000091 80 GiB gp3')).toBe(true)
  })

  it('is false when something real changed alongside the id', () => {
    // The precision that filtering these fields out would have thrown away.
    expect(onlyIdsDiffer('vol-0000000001 80 GiB gp3', 'vol-0000000091 120 GiB gp3')).toBe(false)
  })

  it('is false for identical values — nothing differs at all', () => {
    expect(onlyIdsDiffer('i-0000000001', 'i-0000000001')).toBe(false)
  })
})

describe('matching across a renumbering', () => {
  const stable = [prop('Instance type', 'm6i.xlarge'), prop('Private IPv4', '10.0.11.41')]

  it('pairs a resource whose id moved, and files it as a shift', () => {
    const before = graph([node({ id: 'i-0000000001', props: stable })])
    const after = graph([node({ id: 'i-0000000091', props: stable })])

    const diff = diffGraphs(before, after)
    expect(diff.addedNodes).toEqual([])
    expect(diff.removedNodes).toEqual([])
    expect(diff.structuralChanges).toEqual([])
    expect(diff.idShifts.map((c) => c.field)).toEqual(['id'])
  })

  it('an id shift is never unexplained and never fails', () => {
    const before = graph([node({ id: 'i-0000000001', props: stable })])
    const after = graph([node({ id: 'i-0000000091', props: stable })])
    expect(attribute(diffGraphs(before, after), []).unexplained).toEqual([])
  })

  it('still reports a real change on a paired resource', () => {
    const before = graph([node({ id: 'i-0000000001', props: stable })])
    const after = graph([
      node({
        id: 'i-0000000091',
        props: [prop('Instance type', 'm6i.2xlarge'), prop('Private IPv4', '10.0.11.41')],
      }),
    ])

    const diff = diffGraphs(before, after)
    // A resized instance is not the same resource, so it does not pair at all.
    expect(diff.removedNodes).toHaveLength(1)
    expect(diff.addedNodes).toHaveLength(1)
    expect(attribute(diff, []).unexplained.length).toBeGreaterThan(0)
  })

  it('reports a changed field on a paired resource as structural, not a shift', () => {
    const before = graph([
      node({ id: 'i-0000000001', props: [...stable, prop('EBS', 'vol-0000000001 80 GiB gp3')] }),
    ])
    const after = graph([
      node({ id: 'i-0000000091', props: [...stable, prop('EBS', 'vol-0000000091 80 GiB gp3')] }),
    ])
    const diff = diffGraphs(before, after)
    expect(diff.structuralChanges).toEqual([])
    expect(diff.idShifts.some((c) => c.field === 'props.EBS')).toBe(true)
  })

  it('maps edge endpoints through the match so edges are not double-counted', () => {
    const edge = (source: string, target: string): GraphEdge => ({
      id: `${source}->${target}`,
      source,
      target,
      kind: 'traffic',
      label: '8080',
      meta: {},
    })
    const before = graph(
      [node({ id: 'i-0000000001', props: stable }), node({ id: 'i-0000000002', props: [prop('Private IPv4', '10.0.11.42')] })],
      [edge('i-0000000001', 'i-0000000002')],
    )
    const after = graph(
      [node({ id: 'i-0000000091', props: stable }), node({ id: 'i-0000000092', props: [prop('Private IPv4', '10.0.11.42')] })],
      [edge('i-0000000091', 'i-0000000092')],
    )

    const diff = diffGraphs(before, after)
    expect(diff.addedEdges).toEqual([])
    expect(diff.removedEdges).toEqual([])
  })
})

describe('ambiguity is refused, not guessed', () => {
  /**
   * Two resources that are structurally identical but differ in runtime state
   * cannot be paired without guessing, and a wrong guess would invent a
   * "state changed" that never happened.
   */
  it('refuses to pair when candidates differ only in runtime state', () => {
    const shared = [prop('Instance type', 'm6i.xlarge')]
    const before = graph([
      node({ id: 'i-0000000001', props: shared, state: 'running' }),
      node({ id: 'i-0000000002', props: shared, state: 'stopped' }),
    ])
    const after = graph([
      node({ id: 'i-0000000091', props: shared, state: 'running' }),
      node({ id: 'i-0000000092', props: shared, state: 'stopped' }),
    ])

    const diff = diffGraphs(before, after)
    expect(diff.ambiguities).toHaveLength(1)
    expect(diff.ambiguities[0]?.type).toBe('ec2')
    expect(diff.ambiguities[0]?.reason).toMatch(/guess/)
  })

  it('an ambiguity is fatal', () => {
    const shared = [prop('Instance type', 'm6i.xlarge')]
    const before = graph([
      node({ id: 'i-0000000001', props: shared, state: 'running' }),
      node({ id: 'i-0000000002', props: shared, state: 'stopped' }),
    ])
    const after = graph([
      node({ id: 'i-0000000091', props: shared, state: 'running' }),
      node({ id: 'i-0000000092', props: shared, state: 'stopped' }),
    ])
    expect(attribute(diffGraphs(before, after), []).unexplained.length).toBeGreaterThan(0)
  })

  it('pairs interchangeable duplicates without complaint', () => {
    // Genuinely identical resources: any pairing is correct, so no ambiguity.
    const shared = [prop('Instance type', 'm6i.xlarge')]
    const before = graph([
      node({ id: 'i-0000000001', props: shared }),
      node({ id: 'i-0000000002', props: shared }),
    ])
    const after = graph([
      node({ id: 'i-0000000091', props: shared }),
      node({ id: 'i-0000000092', props: shared }),
    ])

    const diff = diffGraphs(before, after)
    expect(diff.ambiguities).toEqual([])
    expect(diff.structuralChanges).toEqual([])
    expect(attribute(diff, []).unexplained).toEqual([])
  })

  it('reports a surplus of interchangeable duplicates as a removal', () => {
    const shared = [prop('Instance type', 'm6i.xlarge')]
    const before = graph([
      node({ id: 'i-0000000001', props: shared }),
      node({ id: 'i-0000000002', props: shared }),
    ])
    const after = graph([node({ id: 'i-0000000091', props: shared })])

    const diff = diffGraphs(before, after)
    expect(diff.removedNodes).toHaveLength(1)
    expect(diff.ambiguities).toEqual([])
  })
})

describe('containment disambiguates otherwise identical resources', () => {
  it('does not pair a task in one subnet with a task in another', () => {
    const subnetA = node({ id: 'subnet-0000000001', type: 'subnet', category: 'network', cidr: '10.0.1.0/24', isPublic: true })
    const subnetB = node({ id: 'subnet-0000000002', type: 'subnet', category: 'network', cidr: '10.0.2.0/24', isPublic: false })
    const shared = [prop('Launch type', 'FARGATE')]

    const before = graph([
      subnetA,
      subnetB,
      node({ id: 'task-a', type: 'ecs-task', parentId: 'subnet-0000000001', props: shared }),
    ])
    const after = graph([
      subnetA,
      subnetB,
      node({ id: 'task-b', type: 'ecs-task', parentId: 'subnet-0000000002', props: shared }),
    ])

    const diff = diffGraphs(before, after)
    // Different parents means different fingerprints; this is a move, reported
    // as a removal plus an addition rather than a silent pairing.
    expect(diff.removedNodes).toHaveLength(1)
    expect(diff.addedNodes).toHaveLength(1)
  })
})
