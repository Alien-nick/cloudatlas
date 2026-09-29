import { describe, expect, it } from 'vitest'
import {
  benchmarkResources,
  recommendations,
  scoreControls,
  selectFrameworks,
  summarizeControls,
  type ComplianceReport,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type SecurityGroup,
} from '@cloudatlas/shared'
import { emptyRegionScanData } from '../collectors/types.js'
import { buildRegionGraph, plaintextListenersFact } from '../graph/build.js'
import { DemoProvider } from '../providers/demo/index.js'
import { CHECKS, buildCheckContext } from './checks.js'
import { OUTSIDE_VPC_SCOPE_ID, evaluateCompliance } from './evaluate.js'
import { FRAMEWORKS } from './frameworks.js'

function node(patch: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: patch.id,
    abbr: 'X',
    typeLabel: 'resource',
    region: 'us-east-1',
    az: null,
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

function graphOf(
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
  securityGroups: SecurityGroup[] = [],
): Graph {
  return {
    nodes,
    edges,
    securityGroups,
    regions: [],
    missingPermissions: [],
    collectorFailures: [],
    scannedAt: 1,
    accountId: '111122223333',
    accountAlias: null,
    profile: 'test',
  }
}

const edge = (source: string, target: string, kind: GraphEdge['kind'] = 'traffic'): GraphEdge => ({
  id: `${kind}:${source}->${target}`,
  source,
  target,
  kind,
  meta: {},
})

function resultFor(report: ComplianceReport, checkId: string, nodeId: string) {
  return report.results.find((result) => result.checkId === checkId && result.nodeId === nodeId)
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

describe('the control catalog', () => {
  it('maps only to checks that exist', () => {
    const ids = new Set(CHECKS.map((check) => check.id))
    for (const framework of FRAMEWORKS) {
      for (const control of framework.controls) {
        for (const checkId of control.checkIds) expect(ids, `${control.id} → ${checkId}`).toContain(checkId)
      }
    }
  })

  it('uses every check in at least one framework', () => {
    const mapped = new Set(FRAMEWORKS.flatMap((f) => f.controls.flatMap((c) => c.checkIds)))
    for (const check of CHECKS) expect(mapped, check.id).toContain(check.id)
  })

  it('gives every unassessable control a note saying what a human must supply', () => {
    for (const framework of FRAMEWORKS) {
      for (const control of framework.controls.filter((c) => c.checkIds.length === 0)) {
        expect(control.coverageNote, control.id).toBeTruthy()
      }
    }
  })

  it('has unique control and check ids', () => {
    const controls = FRAMEWORKS.flatMap((f) => f.controls.map((c) => c.id))
    expect(new Set(controls).size).toBe(controls.length)
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length)
  })
})

// ---------------------------------------------------------------------------
// Missing data is unknown, never compliant
// ---------------------------------------------------------------------------

describe('a fact the scan did not collect', () => {
  /**
   * The failure a compliance view cannot have: a denied call removes a prop,
   * and the control reads as met. Every check is run against a node with no
   * props at all, and none of them may pass.
   */
  const TYPES: NodeType[] = [
    'vpc', 'subnet', 'ec2', 'rds', 'rds-cluster', 'elasticache', 'alb', 's3', 'sqs',
    'cloudfront', 'waf-web-acl',
  ]

  for (const check of CHECKS) {
    it(`${check.id} does not pass on an empty node`, () => {
      const context = buildCheckContext(graphOf([]))
      const candidates = TYPES.map((type) =>
        node({ id: `${type}-1`, type, securityGroupIds: ['sg-not-collected'] }),
      ).filter((candidate) => check.applies(candidate))

      expect(candidates.length, 'check applies to no type in the list').toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(check.evaluate(candidate, context).status, candidate.type).toBe('unknown')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// The builder ↔ check contract
// ---------------------------------------------------------------------------

describe('the vocabulary the builder writes is the one the checks read', () => {
  /**
   * If the builder's wording drifts, a check stops matching and silently
   * reports `unknown` across a real account. Built from SDK-shaped input so
   * the strings are the ones a live scan produces.
   */
  const built = buildRegionGraph(
    {
      ...emptyRegionScanData('us-east-1'),
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', IsDefault: true }],
      subnets: [
        { SubnetId: 'subnet-pub', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1a', MapPublicIpOnLaunch: true },
      ],
      routeTables: [
        {
          VpcId: 'vpc-1',
          Associations: [{ SubnetId: 'subnet-pub' }],
          Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }],
        },
      ],
      dbInstances: [
        {
          DBInstanceIdentifier: 'db-1',
          Engine: 'postgres',
          AvailabilityZone: 'us-east-1a',
          DBSubnetGroup: {
            VpcId: 'vpc-1',
            Subnets: [{ SubnetIdentifier: 'subnet-pub', SubnetAvailabilityZone: { Name: 'us-east-1a' } }],
          },
          StorageEncrypted: false,
          PubliclyAccessible: true,
          MultiAZ: false,
          BackupRetentionPeriod: 0,
          DeletionProtection: false,
          EnabledCloudwatchLogsExports: [],
        },
      ],
      loadBalancers: [
        {
          LoadBalancerArn: 'arn:alb/1',
          LoadBalancerName: 'alb-1',
          Type: 'application',
          Scheme: 'internet-facing',
          VpcId: 'vpc-1',
          AvailabilityZones: [{ SubnetId: 'subnet-pub', ZoneName: 'us-east-1a' }],
        },
      ],
      listeners: [{ LoadBalancerArn: 'arn:alb/1', Protocol: 'HTTP', Port: 80, DefaultActions: [{ Type: 'forward' }] }],
    },
    '111122223333',
  )
  const report = evaluateCompliance(graphOf(built.nodes, built.edges, built.securityGroups))

  it.each([
    ['vpc-flow-logs', 'vpc-1'],
    ['vpc-not-default', 'vpc-1'],
    ['subnet-no-auto-public-ip', 'subnet-pub'],
    ['data-tier-private-subnet', 'db-1'],
    ['rds-not-public', 'db-1'],
    ['rds-encrypted', 'db-1'],
    ['rds-multi-az', 'db-1'],
    ['rds-backups', 'db-1'],
    ['rds-deletion-protection', 'db-1'],
    ['rds-log-exports', 'db-1'],
    ['alb-tls', 'arn:alb/1'],
    ['public-alb-waf', 'arn:alb/1'],
  ])('%s fails on %s', (checkId, nodeId) => {
    expect(resultFor(report, checkId, nodeId)?.status).toBe('fail')
  })
})

describe('a call that failed is not a configuration that is off', () => {
  it('reports flow logs as unknown when DescribeFlowLogs was denied', () => {
    const built = buildRegionGraph(
      {
        ...emptyRegionScanData('us-east-1'),
        vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
        warnings: [{ action: 'ec2:DescribeFlowLogs', region: 'us-east-1', section: 'network', message: 'denied' }],
      },
      '111122223333',
    )
    const report = evaluateCompliance(graphOf(built.nodes))
    expect(resultFor(report, 'vpc-flow-logs', 'vpc-1')?.status).toBe('unknown')
  })

  it('reports a queue as unknown, not unencrypted, when its attributes could not be read', () => {
    const built = buildRegionGraph(
      { ...emptyRegionScanData('us-east-1'), queueUrls: ['https://sqs.us-east-1.amazonaws.com/111122223333/jobs'] },
      '111122223333',
    )
    const queue = built.nodes.find((candidate) => candidate.type === 'sqs')
    expect(queue).toBeDefined()
    const report = evaluateCompliance(graphOf(built.nodes))
    expect(resultFor(report, 'sqs-encrypted', queue!.id)?.status).toBe('unknown')
  })
})

describe('plaintextListenersFact', () => {
  it('does not count an HTTP listener that redirects to HTTPS', () => {
    expect(
      plaintextListenersFact([
        { Protocol: 'HTTPS', Port: 443 },
        { Protocol: 'HTTP', Port: 80, DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS' } }] },
      ]),
    ).toBe('none')
  })

  it('lists HTTP listeners that serve content', () => {
    expect(
      plaintextListenersFact([{ Protocol: 'HTTP', Port: 8080, DefaultActions: [{ Type: 'forward' }] }]),
    ).toBe('HTTP:8080')
  })

  it('claims nothing when there are no listeners', () => {
    expect(plaintextListenersFact([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Checks that read the graph rather than one prop
// ---------------------------------------------------------------------------

describe('public-alb-waf', () => {
  const alb = node({ id: 'alb', type: 'alb', props: [{ k: 'Scheme', v: 'internet-facing' }] })

  it('passes with a web ACL on the load balancer', () => {
    const waf = node({ id: 'waf', type: 'waf-web-acl' })
    const report = evaluateCompliance(graphOf([alb, waf], [edge('waf', 'alb', 'sg')]))
    expect(resultFor(report, 'public-alb-waf', 'alb')?.status).toBe('pass')
  })

  it('passes behind a protected distribution, and says what that does not cover', () => {
    const cf = node({ id: 'cf', type: 'cloudfront' })
    const waf = node({ id: 'waf', type: 'waf-web-acl' })
    const report = evaluateCompliance(graphOf([alb, cf, waf], [edge('cf', 'alb'), edge('waf', 'cf', 'sg')]))
    const result = resultFor(report, 'public-alb-waf', 'alb')
    expect(result?.status).toBe('pass')
    expect(result?.evidence.join(' ')).toMatch(/bypass/)
  })

  it('does not apply to an internal load balancer', () => {
    const internal = node({ id: 'alb', type: 'alb', props: [{ k: 'Scheme', v: 'internal' }] })
    expect(resultFor(evaluateCompliance(graphOf([internal])), 'public-alb-waf', 'alb')).toBeUndefined()
  })
})

describe('sg-no-world-admin-ports', () => {
  it('fails on a risky rule and names it', () => {
    const sg: SecurityGroup = {
      id: 'sg-1',
      name: 'ssh-open',
      vpcId: 'vpc-1',
      rules: [
        { direction: 'in', protocol: 'tcp', port: '22', fromPort: 22, toPort: 22, source: '0.0.0.0/0', risky: true },
      ],
    }
    const report = evaluateCompliance(graphOf([node({ id: 'i-1', securityGroupIds: ['sg-1'] })], [], [sg]))
    const result = resultFor(report, 'sg-no-world-admin-ports', 'i-1')
    expect(result?.status).toBe('fail')
    expect(result?.evidence[0]).toContain('tcp/22 from 0.0.0.0/0')
  })
})

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

describe('scopes', () => {
  const vpc = node({ id: 'vpc-1', type: 'vpc', vpcId: 'vpc-1', name: 'prod' })
  const db = node({ id: 'db', type: 'rds', vpcId: 'vpc-1' })
  const bucket = node({ id: 'bucket', type: 's3' })
  const loneQueue = node({ id: 'queue', type: 'sqs' })
  const orphan = node({ id: 'i-orphan', vpcId: 'vpc-undescribed' })
  const internet = node({ id: 'internet', type: 'internet' })

  const report = evaluateCompliance(
    graphOf(
      [vpc, db, bucket, loneQueue, orphan, internet],
      [edge('db', 'bucket', 'event'), edge('internet', 'db', 'risk')],
    ),
  )
  const scope = (id: string) => report.scopes.find((candidate) => candidate.id === id)

  it('pulls in resources outside any VPC that the VPC talks to', () => {
    expect(scope('vpc-1')?.connectedNodeIds).toEqual(['bucket'])
    expect(scope('vpc-1')?.nodeIds).toEqual(['vpc-1', 'db'])
  })

  it('keeps every resource outside a VPC in the outside scope, connected or not', () => {
    expect(scope(OUTSIDE_VPC_SCOPE_ID)?.nodeIds.sort()).toEqual(['bucket', 'queue'])
  })

  it('gives resources of a VPC that was not described a scope of their own', () => {
    expect(scope('vpc-undescribed')?.nodeIds).toEqual(['i-orphan'])
  })

  it('never assesses the synthetic internet node', () => {
    expect(report.results.some((result) => result.nodeId === 'internet')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('control summaries', () => {
  const report = evaluateCompliance(
    graphOf([
      node({ id: 'vpc-1', type: 'vpc', vpcId: 'vpc-1', props: [{ k: 'Flow logs', v: 'not enabled' }] }),
      // No props: every check on it is unknown.
      node({ id: 'queue', type: 'sqs' }),
    ]),
  )
  const summaries = summarizeControls(report, 'hipaa', null)
  const byRef = (ref: string) => summaries.find((summary) => summary.control.ref === ref)

  it('reports a failing check as a gap and lists the resource', () => {
    expect(byRef('§164.312(b)')?.status).toBe('gap')
    expect(byRef('§164.312(b)')?.failing.map((r) => r.nodeId)).toEqual(['vpc-1'])
  })

  it('reports unread facts as unknown, not met', () => {
    expect(byRef('§164.312(a)(2)(iv)')?.status).toBe('unknown')
  })

  it('separates not-applicable from not-assessed', () => {
    expect(byRef('§164.308(a)(7)(ii)(A)')?.status).toBe('not-applicable')
    expect(byRef('§164.308(b)(1)')?.status).toBe('not-assessed')
  })

  it('lists gaps first', () => {
    expect(summaries[0]?.status).toBe('gap')
  })

  it('counts unknown against the score', () => {
    const score = scoreControls(summaries)
    expect(score.met).toBe(0)
    expect(score.percent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Per-resource benchmark and recommendations
// ---------------------------------------------------------------------------

describe('benchmark and recommendations', () => {
  const imds = (id: string, v: string) =>
    node({ id, type: 'ec2', props: [{ k: 'IMDS', v }, { k: 'Public IPv4', v: '— (none)' }, { k: 'EBS encryption', v: 'all volumes encrypted' }] })
  const report = evaluateCompliance(
    graphOf([
      imds('i-good', 'v2 required'),
      imds('i-bad-1', 'v1 and v2 allowed'),
      imds('i-bad-2', 'v1 and v2 allowed'),
      node({ id: 'sub', type: 'subnet', props: [{ k: 'Auto-assign public IP', v: 'enabled' }] }),
      node({ id: 'db', type: 'rds', props: [{ k: 'Encryption', v: 'not encrypted' }] }),
    ]),
  )

  it('scores each resource on every check that ran on it, worst first', () => {
    const rows = benchmarkResources(report, null)
    const good = rows.find((row) => row.nodeId === 'i-good')
    expect(good?.score).toMatchObject({ pass: 3, fail: 0, total: 3, percent: 100 })
    expect(rows[rows.length - 1]?.nodeId).toBe('i-good')
    expect(rows.find((row) => row.nodeId === 'i-bad-1')?.score.percent).toBe(67)
  })

  it('ranks fixes by severity, then by how many resources they fix', () => {
    const ranked = recommendations(report, null).map((fix) => [fix.check.id, fix.failing.length])
    // rds-encrypted is high severity; IMDSv2 (medium, two instances) outranks auto-assign (low).
    expect(ranked[0]?.[0]).toBe('rds-encrypted')
    expect(ranked.findIndex(([id]) => id === 'ec2-imdsv2')).toBeLessThan(
      ranked.findIndex(([id]) => id === 'subnet-no-auto-public-ip'),
    )
    expect(ranked.find(([id]) => id === 'ec2-imdsv2')?.[1]).toBe(2)
  })

  it('names the benchmark control a fix closes alongside the framework ones', () => {
    const imdsFix = recommendations(report, null).find((fix) => fix.check.id === 'ec2-imdsv2')
    expect(imdsFix?.controls.map((c) => `${c.framework} ${c.ref}`)).toContain('aws-fsbp EC2.8')
    expect(imdsFix?.controls.some((c) => c.framework === 'hipaa')).toBe(true)
  })
})

describe('selectFrameworks', () => {
  const report = evaluateCompliance(
    graphOf([
      node({ id: 'vpc-1', type: 'vpc', vpcId: 'vpc-1', props: [{ k: 'Default VPC', v: 'yes' }, { k: 'Flow logs', v: 'not enabled' }] }),
    ]),
  )

  it('drops checks only the unselected frameworks require', () => {
    // vpc-not-default evidences SOC 2, PCI DSS — never HIPAA.
    const hipaa = selectFrameworks(report, ['hipaa'])
    expect(hipaa.frameworks.map((f) => f.id)).toEqual(['hipaa'])
    expect(hipaa.results.map((r) => r.checkId)).toEqual(['vpc-flow-logs'])
    expect(recommendations(hipaa, null).map((fix) => fix.check.id)).toEqual(['vpc-flow-logs'])
  })

  it('keeps every check when every framework is selected', () => {
    const all = selectFrameworks(report, FRAMEWORKS.map((f) => f.id))
    expect(all.results).toHaveLength(report.results.length)
  })
})

// ---------------------------------------------------------------------------
// The demo estate
// ---------------------------------------------------------------------------

describe('the demo account', () => {
  it('surfaces the gaps the fixture was built with, and nothing it cannot read', async () => {
    const graph = await new DemoProvider().scan({
      profile: 'cortex-prod',
      regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
    })
    const report = evaluateCompliance(graph)

    const failing = report.results
      .filter((result) => result.status === 'fail')
      .map((result) => `${result.checkId} ${result.nodeId}`)
      .sort()
    expect(failing).toEqual(
      [
        'ebs-encrypted ec2-legacy',
        'ec2-imdsv2 ec2-legacy',
        'public-alb-waf dr-alb',
        's3-public-access-blocked eu-s3-assets',
        'sg-no-world-admin-ports ec2-legacy',
        'sqs-encrypted eu-sqs-events',
        'subnet-no-auto-public-ip subnet-0a12',
        'subnet-no-auto-public-ip subnet-0b34',
        'subnet-no-auto-public-ip subnet-0w1a',
      ].sort(),
    )
    // The fixture states every fact the checks read; an unknown here means a
    // fixture prop drifted from the vocabulary.
    expect(report.results.filter((result) => result.status === 'unknown')).toEqual([])
    expect(report.scopes.map((scope) => scope.name)).toEqual(['prod-vpc', 'dr-vpc', 'Outside any VPC'])
  })
})
