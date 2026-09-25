import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attribute, diffGraphs, isIdentical } from './diff.js'
import { writeFixture, type FixtureOptions } from './fixture-builder.js'
import { replayCapture } from './replay.js'

const created: string[] = []

function fixture(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudatlas-fixture-'))
  created.push(dir)
  return writeFixture(dir, options)
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('replaying a capture', () => {
  it('needs no credentials and consumes every recorded call', async () => {
    const result = await replayCapture(fixture())
    expect(result.accountId).toBe('111122223333')
    expect(result.unconsumed).toEqual([])
  })

  it('rebuilds the full topology through the real collectors and builders', async () => {
    const { graph } = await replayCapture(fixture())
    const byType = new Map<string, number>()
    for (const node of graph.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1)

    expect(byType.get('region')).toBe(1)
    expect(byType.get('vpc')).toBe(1)
    expect(byType.get('az')).toBe(1)
    expect(byType.get('subnet')).toBe(2)
    expect(byType.get('ec2')).toBe(1)
    expect(byType.get('alb')).toBe(1)
    expect(byType.get('rds')).toBe(2)
    expect(byType.get('elasticache')).toBe(1)
    expect(byType.get('ecs-task')).toBe(1)
    expect(byType.get('nat-gateway')).toBe(1)
    expect(byType.get('lambda')).toBe(1)
    expect(byType.get('sqs')).toBe(1)
    expect(byType.get('s3')).toBe(1)
    expect(byType.get('cloudfront')).toBe(1)
    expect(byType.get('route53-zone')).toBe(1)
    expect(byType.get('waf-web-acl')).toBe(2)
  })

  it('runs the account-wide collectors once, not once per region', async () => {
    const { graph } = await replayCapture(fixture())
    // The fixture records exactly one of each global resource. A second copy
    // would mean the global pass had been folded into the region loop.
    expect(graph.nodes.filter((n) => n.type === 'cloudfront')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.type === 'route53-zone')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.type === 'lane' && n.region === 'global')).toHaveLength(1)
  })

  it('places a bucket in its own region, not in the pass that found it', async () => {
    const { graph } = await replayCapture(fixture())
    const bucket = graph.nodes.find((n) => n.type === 's3')
    expect(bucket?.region).toBe('us-east-1')
    expect(bucket?.parentId).toBe('lane:us-east-1')
  })

  it('builds web ACLs in both scopes, each in the right lane', async () => {
    const { graph } = await replayCapture(fixture())
    const acls = graph.nodes.filter((n) => n.type === 'waf-web-acl')
    expect(acls).toHaveLength(2)

    const regional = acls.find((n) => n.props.some((p) => p.v === 'REGIONAL'))
    const cloudfront = acls.find((n) => n.props.some((p) => p.v === 'CLOUDFRONT'))
    expect(regional?.parentId).toBe('lane:us-east-1')
    // A CLOUDFRONT ACL is account-wide, so it belongs in the global lane —
    // placing it in a region lane would imply it only covers that region.
    expect(cloudfront?.region).toBe('global')
    expect(cloudfront?.parentId).toBe('lane:global')
  })

  it('summarises the rules rather than listing them raw', async () => {
    const { graph } = await replayCapture(fixture())
    const regional = graph.nodes.find(
      (n) => n.type === 'waf-web-acl' && n.props.some((p) => p.v === 'REGIONAL'),
    )
    expect(regional?.props.find((p) => p.k === 'Rules')?.v).toBe('1 managed, 1 custom')
    expect(regional?.props.find((p) => p.k === 'Rate limit')?.v).toBe('2,000 req / 5 min per IP')
    expect(regional?.props.find((p) => p.k === 'Default action')?.v).toBe('Allow')
    expect(regional?.props.find((p) => p.k === 'Logging')?.v).toMatch(/^cloudwatch:/)
  })

  it('links each web ACL to what it protects, from both directions', async () => {
    const { graph } = await replayCapture(fixture())
    const regional = graph.nodes.find(
      (n) => n.type === 'waf-web-acl' && n.props.some((p) => p.v === 'REGIONAL'),
    )
    const cloudfront = graph.nodes.find(
      (n) => n.type === 'waf-web-acl' && n.props.some((p) => p.v === 'CLOUDFRONT'),
    )
    const alb = graph.nodes.find((n) => n.type === 'alb')
    const distribution = graph.nodes.find((n) => n.type === 'cloudfront')

    // REGIONAL: read forwards from ListResourcesForWebACL.
    expect(
      graph.edges.some((e) => e.source === regional?.id && e.target === alb?.id),
    ).toBe(true)
    // CLOUDFRONT: read backwards from the distribution's WebACLId, since
    // ListResourcesForWebACL rejects that scope.
    expect(
      graph.edges.some((e) => e.source === cloudfront?.id && e.target === distribution?.id),
    ).toBe(true)
  })

  it('names where flow logs go, even when that is not CloudWatch', async () => {
    const { graph } = await replayCapture(fixture())
    const vpc = graph.nodes.find((n) => n.type === 'vpc')
    // Delivered to S3 in the fixture. An empty Logs tab plus no prop would
    // read as "flow logs are off", which would be wrong.
    expect(vpc?.props.find((p) => p.k === 'Flow logs')?.v).toMatch(/^s3:/)
    expect(vpc?.logGroups).toEqual([])
  })

  it('draws the S3 notification edge to the queue it targets', async () => {
    const { graph } = await replayCapture(fixture())
    const bucket = graph.nodes.find((n) => n.type === 's3')
    const queue = graph.nodes.find((n) => n.type === 'sqs')
    expect(
      graph.edges.some(
        (e) => e.kind === 'event' && e.source === bucket?.id && e.target === queue?.id,
      ),
    ).toBe(true)
  })

  it('draws only the IAM roles something actually references', async () => {
    const { graph } = await replayCapture(fixture())
    const roles = graph.nodes.filter((n) => n.type === 'iam-role')
    // The fixture's one role is the Lambda execution role, which the function
    // references. An unreferenced role would be noise on the diagram.
    expect(roles).toHaveLength(1)
    expect(roles[0]?.props.find((p) => p.k === 'Trusted services')?.v).toBe('lambda.amazonaws.com')
  })

  it('derives the event-source and DNS edges', async () => {
    const { graph } = await replayCapture(fixture())
    const sqs = graph.nodes.find((n) => n.type === 'sqs')
    const lambda = graph.nodes.find((n) => n.type === 'lambda')
    const zone = graph.nodes.find((n) => n.type === 'route53-zone')
    const cf = graph.nodes.find((n) => n.type === 'cloudfront')

    expect(
      graph.edges.some((e) => e.kind === 'event' && e.source === sqs?.id && e.target === lambda?.id),
    ).toBe(true)
    // The zone's A record aliases the distribution's domain name.
    expect(
      graph.edges.some((e) => e.kind === 'traffic' && e.source === zone?.id && e.target === cf?.id),
    ).toBe(true)
    // The distribution's origin is the load balancer's DNS name.
    expect(graph.edges.some((e) => e.source === cf?.id && e.kind === 'traffic')).toBe(true)
  })

  it('classifies subnets from their route tables, including the main-table case', async () => {
    const { graph } = await replayCapture(fixture())
    const subnets = graph.nodes.filter((node) => node.type === 'subnet')
    expect(subnets.find((s) => s.id === 'subnet-0000000001')?.isPublic).toBe(true)
    // No explicit association, so it inherits the main table's NAT route.
    expect(subnets.find((s) => s.id === 'subnet-0000000002')?.isPublic).toBe(false)
  })

  it('derives the load balancer, replication and risk edges', async () => {
    const { graph } = await replayCapture(fixture())
    const kinds = new Set(graph.edges.map((edge) => edge.kind))
    expect(kinds.has('traffic')).toBe(true)
    expect(kinds.has('risk')).toBe(true)

    expect(graph.edges.some((e) => e.target === 'i-0000000001' && e.kind === 'traffic')).toBe(true)
    expect(graph.edges.some((e) => e.source === 'res-6' && e.target === 'res-7')).toBe(true)
    // sg-0000000002 opens 22 to the world, and the instance uses it.
    expect(graph.edges.some((e) => e.kind === 'risk' && e.target === 'i-0000000001')).toBe(true)
  })
})

describe('posture detectors over a replayed fixture', () => {
  it('finds the misconfigurations the fixture actually contains', async () => {
    const { findings } = await replayCapture(fixture())
    const kinds = findings.map((f) => f.kind)

    // The fixture's instance allows IMDSv1 and has an unencrypted volume; its
    // read replica has no StorageEncrypted flag.
    expect(kinds).toContain('imdsv1-allowed')
    expect(kinds).toContain('unencrypted-storage')
    // Nothing in the fixture is publicly accessible.
    expect(kinds).not.toContain('public-database')
  })

  it('badges the affected nodes warn, never critical', async () => {
    const { graph, findings } = await replayCapture(fixture())
    const flagged = new Set(findings.map((f) => f.nodeId))
    for (const node of graph.nodes.filter((n) => flagged.has(n.id))) {
      expect(node.health, node.id).toBe('warn')
    }
  })

  it('is deterministic, so a fixture diff stays clean', async () => {
    const dir = fixture()
    const a = await replayCapture(dir)
    const b = await replayCapture(dir)
    expect(b.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id))
  })
})

describe('determinism', () => {
  /**
   * A capture cannot drift against itself, so this is the check that isolates
   * nondeterminism — unstable ordering, iteration order leaking into an id, or
   * runtime state landing in a structural field — from real account drift.
   */
  it('replays to an identical graph twice', async () => {
    const dir = fixture()
    const first = await replayCapture(dir)
    const second = await replayCapture(dir)
    expect(isIdentical(diffGraphs(first.graph, second.graph))).toBe(true)
  })

  it('produces byte-identical node and edge ids across builds', async () => {
    const dir = fixture()
    const first = await replayCapture(dir)
    const second = await replayCapture(dir)
    expect(second.graph.nodes.map((n) => n.id)).toEqual(first.graph.nodes.map((n) => n.id))
    expect(second.graph.edges.map((e) => e.id)).toEqual(first.graph.edges.map((e) => e.id))
  })

  it('orders nodes and edges stably, not by map iteration chance', async () => {
    const dir = fixture()
    const runs = await Promise.all([replayCapture(dir), replayCapture(dir), replayCapture(dir)])
    const signatures = runs.map((run) =>
      JSON.stringify([run.graph.nodes.map((n) => n.id), run.graph.edges.map((e) => e.id)]),
    )
    expect(new Set(signatures).size).toBe(1)
  })
})

describe('a capture taken with a narrowed policy', () => {
  it('records the denial and drops only what that permission produced', async () => {
    const full = await replayCapture(fixture())
    const narrowed = await replayCapture(
      fixture({ deny: ['elasticache:DescribeCacheClusters'] }),
    )

    expect(narrowed.warnings.map((w) => w.action)).toContain('elasticache:DescribeCacheClusters')
    expect(narrowed.graph.nodes.some((n) => n.type === 'elasticache')).toBe(false)

    const diff = diffGraphs(full.graph, narrowed.graph)
    const { unexplained } = attribute(diff, ['elasticache:DescribeCacheClusters'])
    expect(unexplained).toEqual([])
  })

  it('keeps every other resource identical when one permission is removed', async () => {
    const full = await replayCapture(fixture())
    const narrowed = await replayCapture(
      fixture({ deny: ['elasticache:DescribeCacheClusters'] }),
    )
    const diff = diffGraphs(full.graph, narrowed.graph)

    expect(diff.addedNodes).toEqual([])
    expect(diff.structuralChanges).toEqual([])
    expect(diff.removedNodes.map((n) => n.type)).toEqual(['elasticache'])
  })

  it('is unmoved when every downstream fake id shifted', async () => {
    // The real shape of capture 2: a denied call early in the sequence shortens
    // it, so redaction's encounter-ordered numbering assigns different fakes to
    // everything after that point. Same account, same resources, different ids.
    // Matching on id would report the entire estate as removed and re-added.
    const full = await replayCapture(fixture())
    const shifted = await replayCapture(
      fixture({ deny: ['elasticache:DescribeCacheClusters'], idOffset: 50 }),
    )

    // Confirm the premise: the ids really did all move.
    const fullIds = new Set(full.graph.nodes.map((n) => n.id))
    const shiftedIds = shifted.graph.nodes.map((n) => n.id)
    const overlap = shiftedIds.filter((id) => fullIds.has(id))
    expect(overlap.length).toBeLessThan(shiftedIds.length / 2)

    const diff = diffGraphs(full.graph, shifted.graph)
    const { unexplained } = attribute(diff, ['elasticache:DescribeCacheClusters'])

    expect(unexplained).toEqual([])
    expect(diff.ambiguities).toEqual([])
    expect(diff.structuralChanges).toEqual([])
    expect(diff.removedNodes.map((n) => n.type)).toEqual(['elasticache'])
    // The shift is reported, loudly but separately.
    expect(diff.idShifts.length).toBeGreaterThan(0)
  })

  it('still catches genuine drift hiding behind a renumbering', async () => {
    // The failure mode that matters: if id-shift forgiveness were too broad, a
    // resource appearing between two captures would be absorbed into the noise.
    const before = await replayCapture(fixture())
    const after = await replayCapture(fixture({ idOffset: 50, extraInstance: true }))

    const diff = diffGraphs(before.graph, after.graph)
    const { unexplained } = attribute(diff, [])

    expect(diff.addedNodes.map((n) => n.type)).toEqual(['ec2'])
    expect(unexplained.some((line) => line.includes('ec2 node added'))).toBe(true)
  })

  it('matches structurally even with no denial, only renumbering', async () => {
    const a = await replayCapture(fixture())
    const b = await replayCapture(fixture({ idOffset: 90 }))
    const diff = diffGraphs(a.graph, b.graph)

    expect(diff.addedNodes).toEqual([])
    expect(diff.removedNodes).toEqual([])
    expect(diff.addedEdges).toEqual([])
    expect(diff.removedEdges).toEqual([])
    expect(diff.structuralChanges).toEqual([])
    expect(diff.ambiguities).toEqual([])
    expect(attribute(diff, []).unexplained).toEqual([])
  })

  it('surfaces an unrecognised failure as unclassified, not as a denial', async () => {
    const result = await replayCapture(
      fixture({ unclassify: ['rds:DescribeDBInstances'] }),
    )
    expect(result.unclassified.map((f) => `${f.service}:${f.operation}`)).toContain(
      'rds:DescribeDBInstances',
    )
    expect(result.warnings.map((w) => w.action)).not.toContain('rds:DescribeDBInstances')
    // The section degrades; the rest of the region survives.
    expect(result.graph.nodes.some((n) => n.type === 'rds')).toBe(false)
    expect(result.graph.nodes.some((n) => n.type === 'ec2')).toBe(true)
  })

  it('still builds a graph when the denial is an EC2-style UnauthorizedOperation', async () => {
    const result = await replayCapture(fixture({ deny: ['ec2:DescribeInstances'] }))
    expect(result.warnings.map((w) => w.action)).toContain('ec2:DescribeInstances')
    expect(result.graph.nodes.some((n) => n.type === 'ec2')).toBe(false)
    expect(result.graph.nodes.some((n) => n.type === 'vpc')).toBe(true)
  })
})
