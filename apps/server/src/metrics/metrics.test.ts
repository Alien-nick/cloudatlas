import { describe, expect, it } from 'vitest'
import { choosePeriod, type GraphNode, type MetricDef } from '@cloudatlas/shared'
import { dimensionsFor, loadBalancerDimension, noQueryReason, queriesFor, targetGroupDimension } from './dimensions.js'
import { hasBurstableStorage, isBurstableInstance, unavailableReason } from './availability.js'
import { chunk, MAX_QUERIES_PER_CALL, planMetrics, timestampGrid } from './batch.js'

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'i-0123456789abcdef0',
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

function def(overrides: Partial<MetricDef> = {}): MetricDef {
  return {
    name: 'CPUUtilization',
    namespace: 'AWS/EC2',
    label: 'CPU utilization',
    unit: '%',
    stat: 'Average',
    group: 'Core',
    ...overrides,
  }
}

describe('dimension mapping', () => {
  it('addresses each resource by the identifier CloudWatch actually uses', () => {
    expect(dimensionsFor(node(), 'AWS/EC2')).toEqual([
      { Name: 'InstanceId', Value: 'i-0123456789abcdef0' },
    ])
    expect(dimensionsFor(node({ type: 'rds', id: 'orders-db' }), 'AWS/RDS')).toEqual([
      { Name: 'DBInstanceIdentifier', Value: 'orders-db' },
    ])
    expect(dimensionsFor(node({ type: 'rds-cluster', id: 'orders' }), 'AWS/RDS')).toEqual([
      { Name: 'DBClusterIdentifier', Value: 'orders' },
    ])
  })

  it('returns null rather than an empty dimension list for an unknown pairing', () => {
    // An unqualified query is not a harmless fallback: CloudWatch would answer
    // with an account-wide aggregate, presented in the UI as this one resource.
    expect(dimensionsFor(node({ type: 'vpc' }), 'AWS/EC2')).toBeNull()
    expect(dimensionsFor(node(), 'AWS/Nonsense')).toBeNull()
  })

  it('does not accept an ALB under the NLB namespace or vice versa', () => {
    const arn =
      'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188'
    const alb = node({ type: 'alb', id: arn })
    expect(dimensionsFor(alb, 'AWS/ApplicationELB')).toEqual([
      { Name: 'LoadBalancer', Value: 'app/web/50dc6c495c0c9188' },
    ])
    expect(dimensionsFor(alb, 'AWS/NetworkELB')).toBeNull()
  })

  it('extracts the dimension tails from ARNs', () => {
    expect(
      loadBalancerDimension(
        'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/net/edge/abc123',
      ),
    ).toBe('net/edge/abc123')
    expect(
      targetGroupDimension(
        'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/tg-api/9d2c4f1a',
      ),
    ).toBe('targetgroup/tg-api/9d2c4f1a')
    expect(loadBalancerDimension('not-an-arn')).toBeNull()
  })

  it('needs both ECS dimensions, and asks for neither when the service is unknown', () => {
    const task = node({ type: 'ecs-task', props: [{ k: 'Cluster', v: 'prod', mono: true }] })
    expect(dimensionsFor(task, 'AWS/ECS')).toBeNull()

    const managed = node({
      type: 'ecs-task',
      props: [
        { k: 'Cluster', v: 'prod', mono: true },
        { k: 'Service', v: 'cortex-api', mono: true },
      ],
    })
    expect(dimensionsFor(managed, 'AWS/ECS')).toEqual([
      { Name: 'ClusterName', Value: 'prod' },
      { Name: 'ServiceName', Value: 'cortex-api' },
    ])
  })
})

describe('per-target-group metrics', () => {
  const arn =
    'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188'
  const hostCount = def({
    name: 'UnHealthyHostCount',
    namespace: 'AWS/ApplicationELB',
    label: 'Unhealthy hosts',
    perTargetGroup: true,
  })

  it('fans out into one query per attached target group', () => {
    const alb = node({
      type: 'alb',
      id: arn,
      targetGroups: [
        { name: 'tg-api', dimension: 'targetgroup/tg-api/9d2c4f1a' },
        { name: 'tg-web', dimension: 'targetgroup/tg-web/1a2b3c4d' },
      ],
    })
    const queries = queriesFor(alb, hostCount)
    expect(queries).toHaveLength(2)
    expect(queries[0]?.dimensions).toEqual([
      { Name: 'LoadBalancer', Value: 'app/web/50dc6c495c0c9188' },
      { Name: 'TargetGroup', Value: 'targetgroup/tg-api/9d2c4f1a' },
    ])
    expect(queries.map((q) => q.labelSuffix)).toEqual(['tg-api', 'tg-web'])
  })

  it('asks for nothing, and says why, when no target group is attached', () => {
    const alb = node({ type: 'alb', id: arn, targetGroups: [] })
    expect(queriesFor(alb, hostCount)).toEqual([])
    expect(noQueryReason(alb, hostCount)).toMatch(/per target group/i)
  })

  it('leaves a load-balancer-level metric as a single query', () => {
    const alb = node({ type: 'alb', id: arn, targetGroups: [] })
    const requests = def({ name: 'RequestCount', namespace: 'AWS/ApplicationELB', stat: 'Sum' })
    expect(queriesFor(alb, requests)).toHaveLength(1)
    expect(queriesFor(alb, requests)[0]?.labelSuffix).toBeNull()
  })
})

describe('availability preconditions', () => {
  it('knows which instance and storage families publish burst metrics', () => {
    expect(isBurstableInstance('t3.medium')).toBe(true)
    expect(isBurstableInstance('t4g.small')).toBe(true)
    expect(isBurstableInstance('m5.large')).toBe(false)
    expect(isBurstableInstance(undefined)).toBe(false)

    expect(hasBurstableStorage('100 GiB gp2')).toBe(true)
    expect(hasBurstableStorage('100 GiB gp3')).toBe(false)
  })

  it('does not query a stopped instance', () => {
    expect(unavailableReason(node({ state: 'stopped' }), def())).toMatch(/stopped/i)
    expect(unavailableReason(node({ state: 'running' }), def())).toBeNull()
  })

  it('treats a missing CloudWatch agent as a fact only when the scan recorded one', () => {
    const memory = def({ name: 'mem_used_percent', namespace: 'CWAgent' })
    // Live scans cannot know, so nothing is asserted up front.
    expect(unavailableReason(node(), memory)).toBeNull()
    // The fixture provider does know.
    const known = node({ props: [{ k: 'CloudWatch agent', v: 'not installed', mono: false }] })
    expect(unavailableReason(known, memory)).toMatch(/agent/i)
  })

  it('skips ReplicaLag on an instance that is not a replica', () => {
    const lag = def({ name: 'ReplicaLag', namespace: 'AWS/RDS' })
    const primary = node({ type: 'rds', state: 'available', props: [] })
    expect(unavailableReason(primary, lag)).toMatch(/not a read replica/i)

    const replica = node({
      type: 'rds',
      state: 'available',
      props: [{ k: 'Replica of', v: 'orders-db', mono: true }],
    })
    expect(unavailableReason(replica, lag)).toBeNull()
  })
})

describe('planning a batch', () => {
  it('reports every requested metric, either as a query or as a reason', () => {
    const instance = node({
      state: 'stopped',
      props: [{ k: 'Instance type', v: 'm5.large', mono: true }],
    })
    const defs = [def(), def({ name: 'NetworkIn', label: 'Network in' })]
    const plan = planMetrics({ node: instance, defs, period: 60 })

    expect(plan.planned).toHaveLength(0)
    expect(plan.skipped).toHaveLength(2)
    // A metric dropped without explanation reads as a UI bug, not as information.
    for (const series of plan.skipped) expect(series.unavailableReason).toBeTruthy()
  })

  it('numbers query ids contiguously across a fan-out', () => {
    const arn =
      'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188'
    const alb = node({
      type: 'alb',
      id: arn,
      state: 'active',
      targetGroups: [
        { name: 'tg-api', dimension: 'targetgroup/tg-api/9d2c4f1a' },
        { name: 'tg-web', dimension: 'targetgroup/tg-web/1a2b3c4d' },
      ],
    })
    const defs = [
      def({ name: 'RequestCount', namespace: 'AWS/ApplicationELB', stat: 'Sum' }),
      def({ name: 'UnHealthyHostCount', namespace: 'AWS/ApplicationELB', perTargetGroup: true }),
    ]
    const plan = planMetrics({ node: alb, defs, period: 300 })

    expect(plan.planned.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2'])
    expect(plan.planned.map((entry) => entry.label)).toEqual([
      'CPU utilization',
      'CPU utilization · tg-api',
      'CPU utilization · tg-web',
    ])
    expect(plan.planned[0]?.query.MetricStat?.Period).toBe(300)
  })
})

describe('batching and the timestamp grid', () => {
  it('splits at the CloudWatch limit of 500 queries per call', () => {
    const items = Array.from({ length: 1201 }, (_, i) => i)
    const chunks = chunk(items, MAX_QUERIES_PER_CALL)
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201])
    expect(chunks.flat()).toEqual(items)
  })

  it('builds a period-aligned grid so gaps have a slot to be null in', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 30)
    const end = Date.UTC(2026, 0, 1, 0, 5, 0)
    const grid = timestampGrid(start, end, 60)
    expect(grid).toEqual([
      Date.UTC(2026, 0, 1, 0, 0),
      Date.UTC(2026, 0, 1, 0, 1),
      Date.UTC(2026, 0, 1, 0, 2),
      Date.UTC(2026, 0, 1, 0, 3),
      Date.UTC(2026, 0, 1, 0, 4),
    ])
  })
})

describe('period selection', () => {
  it('keeps a window under the point budget', () => {
    const end = Date.now()
    expect(choosePeriod(end - 3 * 3_600_000, end)).toBe(60)
    expect(choosePeriod(end - 14 * 86_400_000, end)).toBeGreaterThanOrEqual(300)
  })

  it('does not ask for 1-minute resolution CloudWatch no longer retains', () => {
    const end = Date.now()
    expect(choosePeriod(end - 30 * 86_400_000, end)).toBeGreaterThanOrEqual(300)
    expect(choosePeriod(end - 120 * 86_400_000, end)).toBeGreaterThanOrEqual(3600)
  })
})
