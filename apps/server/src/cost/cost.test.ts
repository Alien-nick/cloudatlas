import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costServiceOf, nodeTypesForService, savingsTotal, type ActualSpend, type Graph, type GraphNode, type Saving } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { emptyRegionScanData } from '../collectors/types.js'
import { buildRegionGraph, registeredTargetCount } from '../graph/build.js'
import { DemoProvider } from '../providers/demo/index.js'
import { CACHE_TTL_MS, MIN_REFRESH_MS, fetchActualSpend, getActualSpend, setCostExplorerEnabled, spendWindows, sumGroups } from './actual.js'
import { estimateRunRate } from './estimate.js'
import { attachedVolumes, environment, fargateSize, registeredTargets } from './facts.js'
import {
  clearPriceCache,
  loadPriceBook,
  parseProduct,
  priceKeyId,
  priceListText,
  queryFor,
  rdsEngineName,
  selectPrice,
  type PriceBook,
  type PriceKey,
} from './pricing.js'
import { findSavings, savingCandidates } from './savings.js'

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

const graphOf = (nodes: GraphNode[]): Graph => ({
  nodes,
  edges: [],
  securityGroups: [],
  regions: [],
  missingPermissions: [],
  collectorFailures: [],
  scannedAt: 1,
  accountId: '111122223333',
  accountAlias: null,
  profile: 'test',
})

/** A price book over a plain table keyed by priceKeyId. */
const bookOf = (prices: Record<string, number>): PriceBook => ({
  source: 'test',
  get: (key) => prices[priceKeyId(key)] ?? null,
})

const prop = (k: string, v: string) => ({ k, v })

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('price list parsing', () => {
  const product = (unit: string, usd: string, attributes: Record<string, string> = {}) =>
    JSON.stringify({
      product: { attributes },
      terms: { OnDemand: { t: { priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } } } },
    })

  it('reads entries in every shape the SDK returns them', () => {
    const json = product('Hrs', '0.0416')
    // Current SDKs hand back a wrapper whose toString() is the JSON.
    const wrapper = new (class LazyJson { constructor(private readonly text: string) {} toString() { return this.text } })(json)
    for (const entry of [json, wrapper, JSON.parse(json), JSON.stringify(json)]) {
      expect(parseProduct(priceListText(entry))?.prices, typeof entry).toEqual([{ unit: 'Hrs', usd: 0.0416 }])
    }
  })

  it('reads the on-demand price and unit', () => {
    expect(parseProduct(product('Hrs', '0.1920000000'))?.prices).toEqual([{ unit: 'Hrs', usd: 0.192 }])
  })

  it('skips zero prices and other units, so nothing reads as free', () => {
    const products = [product('Hrs', '0.0'), product('GB', '0.045'), product('Hrs', '0.045')].map((json) => parseProduct(json)!)
    expect(selectPrice(products, 'Hrs')).toBe(0.045)
  })

  it('picks the plain Fargate rate from among its variants', () => {
    const query = queryFor({ kind: 'fargate-vcpu', region: 'us-east-1' })!
    const products = [
      product('hours', '0.03238', { usagetype: 'USE1-Fargate-ARM-vCPU-Hours:perCPU' }),
      product('hours', '0.04048', { usagetype: 'USE1-Fargate-vCPU-Hours:perCPU' }),
    ].map((json) => parseProduct(json)!)
    expect(selectPrice(products, 'hours', query.pick)).toBe(0.04048)
  })

  it('names RDS engines the way the Price List does, and refuses to guess licensed ones', () => {
    expect(rdsEngineName('postgres')).toBe('PostgreSQL')
    expect(rdsEngineName('aurora-postgresql')).toBe('Aurora PostgreSQL')
    expect(rdsEngineName('PostgreSQL 15.4')).toBe('PostgreSQL')
    expect(rdsEngineName('oracle-se2')).toBeNull()
  })
})

describe('loadPriceBook', () => {
  beforeEach(() => clearPriceCache())

  const key: PriceKey = { kind: 'ec2', region: 'us-east-1', instanceType: 't3.large' }
  const response = {
    PriceList: [
      JSON.stringify({ terms: { OnDemand: { t: { priceDimensions: { d: { unit: 'Hrs', pricePerUnit: { USD: '0.0832' } } } } } } }),
    ],
  }

  it('asks once per distinct price and answers from memory after', async () => {
    const send = vi.fn(async () => response)
    const aws = { send } as unknown as AwsClient
    const first = await loadPriceBook(aws, [key, key])
    await loadPriceBook(aws, [key])
    expect(send).toHaveBeenCalledTimes(1)
    expect(first.book.get(key)).toBe(0.0832)
  })

  it('reports a denied pricing call instead of pricing everything at nothing', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    const aws = { send: vi.fn(async () => Promise.reject(denied)) } as unknown as AwsClient
    const loaded = await loadPriceBook(aws, [key])
    expect(loaded.failure).toMatch(/pricing:GetProducts/)
    expect(loaded.book.get(key)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

describe('cost facts', () => {
  it('reads volumes in the builder format', () => {
    const ec2 = node({ id: 'i', props: [prop('EBS', 'vol-0a1 80 GiB gp2, vol-0b2 20 GiB gp3')] })
    expect(attachedVolumes(ec2)).toEqual([
      { id: 'vol-0a1', sizeGiB: 80, type: 'gp2' },
      { id: 'vol-0b2', sizeGiB: 20, type: 'gp3' },
    ])
  })

  it('reads a Fargate size from task units and from the readable form', () => {
    const units = node({ id: 't', type: 'ecs-task', props: [prop('Launch type', 'FARGATE'), prop('CPU / memory', '512 / 2048')] })
    const readable = node({ id: 't', type: 'ecs-task', props: [prop('Launch type', 'Fargate · 1 vCPU / 2 GB')] })
    expect(fargateSize(units)).toEqual({ vcpu: 0.5, gb: 2 })
    expect(fargateSize(readable)).toEqual({ vcpu: 1, gb: 2 })
  })

  it('treats an untagged resource as unknown, not as non-production', () => {
    expect(environment(node({ id: 'a' }))).toBe('unknown')
    expect(environment(node({ id: 'a', tags: [{ key: 'Environment', value: 'staging' }] }))).toBe('non-prod')
    expect(environment(node({ id: 'a', tags: [{ key: 'env', value: 'Production' }] }))).toBe('prod')
  })

  it('does not read unrecorded targets as zero', () => {
    expect(registeredTargets(node({ id: 'lb', type: 'alb' }))).toBeNull()
  })
})

describe('the builder', () => {
  it('counts targets only when health was read for every target group', () => {
    const data = { ...emptyRegionScanData('us-east-1'), targetHealth: { a: [{}, {}] } }
    expect(registeredTargetCount(['a'], data)).toBe(2)
    expect(registeredTargetCount(['a', 'b'], data)).toBeNull()
    expect(registeredTargetCount([], data)).toBe(0)
  })

  it('gives unattached volumes a node of their own', () => {
    const built = buildRegionGraph(
      {
        ...emptyRegionScanData('us-east-1'),
        volumes: [
          { VolumeId: 'vol-free', Size: 100, VolumeType: 'gp2', State: 'available', Attachments: [] },
          { VolumeId: 'vol-used', Size: 8, VolumeType: 'gp3', State: 'in-use', Attachments: [{ InstanceId: 'i-1' }] },
        ],
      },
      '111122223333',
    )
    const volumes = built.nodes.filter((candidate) => candidate.type === 'ebs-volume')
    expect(volumes.map((volume) => volume.id)).toEqual(['vol-free'])
    expect(built.nodes.some((candidate) => candidate.type === 'lane')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

describe('estimateRunRate', () => {
  const prices = bookOf({
    [priceKeyId({ kind: 'ec2', region: 'us-east-1', instanceType: 'm6i.xlarge' })]: 0.192,
    [priceKeyId({ kind: 'ebs', region: 'us-east-1', volumeType: 'gp2' })]: 0.1,
  })

  it('prices a running instance and its volumes, and a stopped one only for its volumes', () => {
    const running = node({ id: 'on', props: [prop('Instance type', 'm6i.xlarge'), prop('EBS', 'vol-1 100 GiB gp2')] })
    const stopped = node({ id: 'off', state: 'stopped', props: [prop('Instance type', 'm6i.xlarge'), prop('EBS', 'vol-2 100 GiB gp2')] })
    const runRate = estimateRunRate(graphOf([running, stopped]), prices)
    expect(runRate.lines.filter((line) => line.nodeId === 'on').map((line) => line.monthlyUsd)).toEqual([140.16, 10])
    expect(runRate.lines.filter((line) => line.nodeId === 'off').map((line) => line.monthlyUsd)).toEqual([10])
  })

  it('lists usage-based and unpriceable resources with a reason, never at zero', () => {
    const runRate = estimateRunRate(
      graphOf([node({ id: 'fn', type: 'lambda' }), node({ id: 'x', props: [prop('Instance type', 'x9.huge')] })]),
      prices,
    )
    expect(runRate.lines).toEqual([])
    expect(runRate.unpriced.map((entry) => entry.nodeId)).toEqual(['fn', 'x'])
  })
})

// ---------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------

describe('savings', () => {
  const find = (nodes: GraphNode[], prices: Record<string, number>): Saving[] =>
    findSavings(savingCandidates(graphOf(nodes), { profile: 'p' }), bookOf(prices))
  const ebs = (type: string) => priceKeyId({ kind: 'ebs', region: 'us-east-1', volumeType: type })

  it('suggests gp3 for a gp2 volume in use, with a command per volume', () => {
    const [saving] = find([node({ id: 'i', props: [prop('EBS', 'vol-1 100 GiB gp2')] })], { [ebs('gp2')]: 0.1, [ebs('gp3')]: 0.08 })
    expect(saving?.kind).toBe('gp2-to-gp3')
    expect(saving?.monthlySavingsUsd).toBe(2)
    expect(saving?.fix?.commands[0]).toBe('aws ec2 modify-volume --volume-id vol-1 --volume-type gp3 --region us-east-1 --profile p')
  })

  it('suggests retiring an idle volume rather than tuning it', () => {
    const orphan = node({ id: 'vol', type: 'ebs-volume', state: 'available', props: [prop('Size', '500 GiB'), prop('Volume type', 'gp2')] })
    const kinds = find([orphan], { [ebs('gp2')]: 0.1, [ebs('gp3')]: 0.08 }).map((saving) => saving.kind)
    expect(kinds).toEqual(['unattached-volume'])
  })

  it('makes no claim when a price is missing', () => {
    expect(find([node({ id: 'i', props: [prop('EBS', 'vol-1 100 GiB gp2')] })], {})).toEqual([])
  })

  it('suggests Graviton for EC2 without a command, because an x86 AMI does not boot on arm64', () => {
    const [saving] = find([node({ id: 'i', props: [prop('Instance type', 'm6i.xlarge')] })], {
      [priceKeyId({ kind: 'ec2', region: 'us-east-1', instanceType: 'm6i.xlarge' })]: 0.192,
      [priceKeyId({ kind: 'ec2', region: 'us-east-1', instanceType: 'm6g.xlarge' })]: 0.154,
    })
    expect(saving).toMatchObject({ kind: 'graviton', risk: 'high' })
    expect(saving?.fix).toBeUndefined()
  })

  it('suggests Single-AZ only for a database tagged as non-production', () => {
    const db = (env: string) =>
      node({
        id: `db-${env}`,
        type: 'rds',
        tags: [{ key: 'Environment', value: env }],
        props: [prop('Instance class', 'db.r6g.large'), prop('Engine', 'postgres 16'), prop('Multi-AZ', 'enabled (us-east-1b)')],
      })
    const key = (multiAz: boolean) =>
      priceKeyId({ kind: 'rds', region: 'us-east-1', instanceClass: 'db.r6g.large', engine: 'PostgreSQL', multiAz })
    const found = find([db('staging'), db('prod')], { [key(true)]: 0.45, [key(false)]: 0.225 })
    expect(found.filter((saving) => saving.kind === 'non-prod-multi-az').map((saving) => saving.nodeId)).toEqual(['db-staging'])
  })

  it('flags a load balancer with no targets, but not one whose targets were not read', () => {
    const lb = (id: string, targets?: string) =>
      node({ id, type: 'alb', props: targets === undefined ? [] : [prop('Registered targets', targets)] })
    const found = find([lb('empty', '0'), lb('busy', '3'), lb('unknown')], {
      [priceKeyId({ kind: 'alb', region: 'us-east-1' })]: 0.0225,
    })
    expect(found.map((saving) => saving.nodeId)).toEqual(['empty'])
  })

  it('states the arm64 Lambda saving as a proportion, not dollars', () => {
    const [saving] = find([node({ id: 'fn', type: 'lambda', props: [prop('Architecture', 'x86_64')] })], {})
    expect(saving).toMatchObject({ kind: 'lambda-arm64', monthlySavingsUsd: null })
    expect(saving?.savingsNote).toMatch(/20%/)
  })

  it('counts each resource once when suggestions overlap', () => {
    const base = { title: '', rationale: '', risk: 'low' as const, evidence: [], savingsNote: null }
    expect(
      savingsTotal([
        { ...base, id: 'a', kind: 'x', nodeId: 'n', monthlySavingsUsd: 30 },
        { ...base, id: 'b', kind: 'y', nodeId: 'n', monthlySavingsUsd: 10 },
        { ...base, id: 'c', kind: 'x', nodeId: 'm', monthlySavingsUsd: 5 },
      ]),
    ).toBe(35)
  })
})

// ---------------------------------------------------------------------------
// Actual spend
// ---------------------------------------------------------------------------

describe('Cost Explorer', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cloudatlas-cost-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const ok = (fetchedAt: number): ActualSpend => ({
    status: 'ok',
    message: null,
    currency: 'USD',
    fetchedAt,
    monthToDate: 10,
    lastMonth: 20,
    forecastMonthEnd: 30,
    byService: [],
    byRegion: [],
    daily: [],
  })
  const aws = {} as AwsClient
  const now = new Date(Date.UTC(2026, 8, 15, 12))

  it('makes no request while it is off', async () => {
    const fetch = vi.fn()
    const spend = await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: false, fetch, now })
    expect(spend.status).toBe('disabled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serves the cache inside twelve hours, and throttles manual refreshes', async () => {
    setCostExplorerEnabled(dir, true)
    const fetch = vi.fn(async (_aws: AwsClient, at?: Date) => ok(at!.getTime()))
    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: false, fetch, now })

    const later = (ms: number) => new Date(now.getTime() + ms)
    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: false, fetch, now: later(CACHE_TTL_MS - 1000) })
    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: false, fetch, refresh: true, now: later(MIN_REFRESH_MS - 1000) })
    expect(fetch).toHaveBeenCalledTimes(1)

    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: false, fetch, refresh: true, now: later(MIN_REFRESH_MS + 1000) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure', async () => {
    const fetch = vi.fn(async () => ({ ...ok(0), status: 'error' as const, fetchedAt: null }))
    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: true, fetch, now })
    await getActualSpend({ aws, profile: 'p', dataDir: dir, enabledByConfig: true, fetch, now })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('splits this month from last month and adds the forecast to month to date', async () => {
    const groups = (service: string, amount: string) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } })
    const send = vi.fn(async (_service: string, _region: string, operation: string, command: { input: Record<string, unknown> }) => {
      if (operation === 'GetCostForecast') return { Total: { Amount: '90' } }
      if (command.input.Granularity === 'DAILY') {
        return { ResultsByTime: [{ TimePeriod: { Start: '2026-09-14' }, Groups: [groups('Amazon RDS', '3'), groups('AWS Lambda', '0.5')] }] }
      }
      const groupBy = (command.input.GroupBy as Array<{ Key: string }>)[0]?.Key
      if (groupBy === 'REGION') return { ResultsByTime: [{ TimePeriod: { Start: '2026-09-01' }, Groups: [groups('us-east-1', '60')] }] }
      return {
        ResultsByTime: [
          { TimePeriod: { Start: '2026-08-01' }, Groups: [groups('Amazon RDS', '100')] },
          { TimePeriod: { Start: '2026-09-01' }, Groups: [groups('Amazon RDS', '50'), groups('AWS Lambda', '10')] },
        ],
      }
    })
    const spend = await fetchActualSpend({ send } as unknown as AwsClient, now)
    expect(spend).toMatchObject({ status: 'ok', monthToDate: 60, lastMonth: 100, forecastMonthEnd: 150 })
    expect(spend.byService[0]).toEqual({ key: 'Amazon RDS', monthToDate: 50, lastMonth: 100 })
    expect(spend.daily).toEqual([{ key: '2026-09-14', amount: 3.5 }])
    expect(spend.dailyByService).toEqual([
      { key: 'Amazon RDS', amounts: [3] },
      { key: 'AWS Lambda', amounts: [0.5] },
    ])
  })

  it('reports a denied call as denied', async () => {
    const denied = Object.assign(new Error('no'), { name: 'AccessDeniedException' })
    const spend = await fetchActualSpend({ send: vi.fn(async () => Promise.reject(denied)) } as unknown as AwsClient, now)
    expect(spend.status).toBe('denied')
  })

  it('computes its windows across a year boundary', () => {
    expect(spendWindows(new Date(Date.UTC(2027, 0, 10)))).toMatchObject({
      monthStart: '2027-01-01',
      lastMonthStart: '2026-12-01',
      nextMonthStart: '2027-02-01',
    })
  })

  it('sums groups only for the periods asked for', () => {
    const results = [
      { TimePeriod: { Start: '2026-08-01', End: '2026-09-01' }, Groups: [{ Keys: ['a'], Metrics: { UnblendedCost: { Amount: '1' } } }] },
      { TimePeriod: { Start: '2026-09-01', End: '2026-09-16' }, Groups: [{ Keys: ['a'], Metrics: { UnblendedCost: { Amount: '2' } } }] },
    ]
    expect(sumGroups(results, (start) => start >= '2026-09-01').get('a')).toBe(2)
  })
})

describe('the Cost Explorer service a cost line bills under', () => {
  it('splits an instance into compute and its volumes, as the bill does', () => {
    expect(costServiceOf('ec2', 'Instance (m6i.xlarge)')).toBe('Amazon Elastic Compute Cloud - Compute')
    expect(costServiceOf('ec2', 'Volume vol-1 (gp2)')).toBe('EC2 - Other')
    expect(costServiceOf('nat-gateway')).toBe('EC2 - Other')
    expect(costServiceOf('iam-role')).toBeNull()
  })

  it('lists instances under both EC2 services, since they bill under both', () => {
    expect(nodeTypesForService('EC2 - Other')).toEqual(expect.arrayContaining(['ebs-volume', 'nat-gateway', 'ec2']))
    expect(nodeTypesForService('Amazon Relational Database Service')).toEqual(['rds', 'rds-cluster'])
  })
})

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

describe('the demo account', () => {
  it('produces a run-rate, labelled demo spend, and the savings its fixture was built with', async () => {
    const provider = new DemoProvider()
    await provider.scan({ profile: 'cortex-prod', regions: ['us-east-1', 'us-west-2', 'eu-west-1'] })
    const report = (await provider.getCostReport())!

    expect(report.actual.status).toBe('demo')
    expect(report.runRate.lines.length).toBeGreaterThan(10)
    expect(report.savings.map((saving) => `${saving.kind} ${saving.nodeId}`).sort()).toEqual(
      [
        'graviton ec2-batch',
        'gp2-to-gp3 ec2-batch',
        'lambda-arm64 lambda',
        'stopped-instance-storage ec2-legacy',
        'unattached-volume vol-orphan',
      ].sort(),
    )
  })
})
