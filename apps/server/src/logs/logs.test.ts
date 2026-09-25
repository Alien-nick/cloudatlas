import { describe, expect, it } from 'vitest'
import type { GraphNode, LogQueryRequest } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { classifyLogGroup, discoverLogGroups, expectedLogGroups, offCloudWatchDestinations } from './groups.js'
import { histogramOf, queryLogs, toFilterPattern, toLogEvent } from './filter.js'

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0)

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n-1',
    arn: null,
    type: 'lambda',
    category: 'compute',
    name: 'image-resize',
    abbr: 'L',
    typeLabel: 'Lambda function',
    region: 'us-east-1',
    az: null,
    vpcId: null,
    subnetId: null,
    parentId: null,
    state: 'active',
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

function stubClient(handlers: {
  describe?: (prefix: string) => unknown
  filter?: (group: string, token: string | undefined) => unknown
}): { aws: AwsClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const aws = {
    async collect(options: {
      command: (token?: string) => { input: Record<string, unknown> }
      items: (out: unknown) => unknown[] | undefined
    }) {
      const command = options.command(undefined)
      calls.push(command.input)
      const out = handlers.describe?.(command.input.logGroupNamePrefix as string) ?? {}
      return options.items(out) ?? []
    },
    async send(_s: string, _r: string, _op: string, command: { input: Record<string, unknown> }) {
      calls.push(command.input)
      const result = handlers.filter?.(
        command.input.logGroupName as string,
        command.input.nextToken as string | undefined,
      )
      if (result instanceof Error) throw result
      return result ?? {}
    },
  } as unknown as AwsClient
  return { aws, calls }
}

describe('deciding what the user typed', () => {
  it('quotes a plain string, which is what most searches are', () => {
    // Unquoted, CloudWatch rejects these as invalid pattern syntax rather than
    // returning no results — so the search looks broken instead of empty.
    expect(toFilterPattern('timeout')).toBe('"timeout"')
    expect(toFilterPattern('error:')).toBe('"error:"')
    expect(toFilterPattern('5xx')).toBe('"5xx"')
    expect(toFilterPattern('  padded  ')).toBe('"padded"')
  })

  it('passes real filter syntax through untouched', () => {
    expect(toFilterPattern('{ $.level = "ERROR" }')).toBe('{ $.level = "ERROR" }')
    expect(toFilterPattern('[ip, user, ...]')).toBe('[ip, user, ...]')
    expect(toFilterPattern('"already quoted"')).toBe('"already quoted"')
    expect(toFilterPattern('?ERROR ?WARN')).toBe('?ERROR ?WARN')
  })

  it('escapes embedded quotes so a literal stays one term', () => {
    expect(toFilterPattern('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('treats an empty search as no filter at all', () => {
    expect(toFilterPattern('')).toBe('')
    expect(toFilterPattern('   ')).toBe('')
  })
})

describe('classifying a log group', () => {
  it('maps names to the vocabulary the Insights templates match on', () => {
    expect(classifyLogGroup('/aws/rds/instance/db-1/postgresql', node({ type: 'rds' }))).toBe('rds')
    expect(classifyLogGroup('/aws/lambda/image-resize', node())).toBe('lambda')
    expect(classifyLogGroup('aws-waf-logs-cortex', node())).toBe('waf')
    expect(classifyLogGroup('/aws/ecs/prod', node({ type: 'ecs-task' }))).toBe('ecs')
    expect(classifyLogGroup('/my/custom/group', node({ type: 'ec2' }))).toBe('ec2')
    expect(classifyLogGroup('/my/custom/group', node({ type: 'alb' }))).toBe('generic')
  })

  it('infers a Lambda group name when the collector recorded none', () => {
    expect(expectedLogGroups(node())).toEqual(['/aws/lambda/image-resize'])
    // An explicitly configured group wins over the convention.
    expect(expectedLogGroups(node({ logGroups: ['/custom/lambda'] }))).toEqual(['/custom/lambda'])
  })

  it('names the S3 destination for load balancer access logs', () => {
    const refs = offCloudWatchDestinations(node({ type: 'alb', name: 'api-alb' }), 'us-east-1')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.exists).toBe(false)
    expect(refs[0]?.hint).toMatch(/S3, not CloudWatch/)
    // An empty picker would read as "logging is off", which is usually wrong.
    expect(offCloudWatchDestinations(node(), 'us-east-1')).toEqual([])
  })
})

describe('discovering groups', () => {
  it('matches the group name exactly, not by prefix', async () => {
    // DescribeLogGroups only filters by prefix, so /aws/lambda/image-resize
    // also matches /aws/lambda/image-resize-v2. Taking the first result would
    // report the neighbour's stored size as this group's.
    const { aws } = stubClient({
      describe: () => ({
        logGroups: [
          { logGroupName: '/aws/lambda/image-resize-v2', storedBytes: 999 },
          { logGroupName: '/aws/lambda/image-resize', storedBytes: 42 },
        ],
      }),
    })
    const refs = await discoverLogGroups({ aws, node: node() })
    expect(refs[0]?.exists).toBe(true)
    expect(refs[0]?.storedBytes).toBe(42)
  })

  it('reports an expected-but-absent group with what to switch on', async () => {
    const { aws } = stubClient({ describe: () => ({ logGroups: [] }) })
    const refs = await discoverLogGroups({
      aws,
      node: node({ type: 'rds', name: 'orders-db', logGroups: ['/aws/rds/instance/orders-db/postgresql'] }),
    })
    // Listed, not omitted: "logging was never enabled" is usually the answer.
    expect(refs[0]?.exists).toBe(false)
    expect(refs[0]?.hint).toMatch(/Enable log exports/)
  })

  it('does not claim a group is missing when it merely could not look', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    const aws = {
      async collect() {
        throw denied
      },
    } as unknown as AwsClient

    const warnings: string[] = []
    const refs = await discoverLogGroups({ aws, node: node(), onWarning: (a) => warnings.push(a) })
    expect(refs[0]?.exists).toBe(true)
    expect(refs[0]?.hint).toMatch(/Could not confirm/)
    expect(warnings).toHaveLength(1)
  })
})

function request(overrides: Partial<LogQueryRequest> = {}): LogQueryRequest {
  return {
    logGroups: ['/a'],
    region: 'us-east-1',
    start: T0,
    end: T0 + 600_000,
    filterPattern: '',
    limit: 500,
    ...overrides,
  }
}

describe('searching', () => {
  it('merges groups in timestamp order', async () => {
    const { aws } = stubClient({
      filter: (group) =>
        group === '/a'
          ? { events: [{ timestamp: T0 + 2000, message: 'from a', logStreamName: 's', eventId: 'a1' }] }
          : { events: [{ timestamp: T0 + 1000, message: 'from b', logStreamName: 's', eventId: 'b1' }] },
    })
    const result = await queryLogs({ aws, request: request({ logGroups: ['/a', '/b'] }) })
    expect(result.events.map((e) => e.message)).toEqual(['from b', 'from a'])
  })

  it('divides the limit between groups instead of biasing toward one', async () => {
    const { aws, calls } = stubClient({ filter: () => ({ events: [] }) })
    await queryLogs({ aws, request: request({ logGroups: ['/a', '/b', '/c'], limit: 300 }) })
    for (const call of calls) expect(call.limit).toBe(100)
  })

  it('reports truncation rather than presenting a clipped result as complete', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      timestamp: T0 + i * 1000,
      message: `line ${i}`,
      logStreamName: 's',
      eventId: `e${i}`,
    }))
    const { aws } = stubClient({ filter: () => ({ events, nextToken: 'more' }) })
    const result = await queryLogs({ aws, request: request({ limit: 10 }) })
    expect(result.truncated).toBe(true)
  })

  it('keeps searching other groups when one is denied', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    const { aws } = stubClient({
      filter: (group) =>
        group === '/a'
          ? denied
          : { events: [{ timestamp: T0, message: 'ok', logStreamName: 's', eventId: 'x' }] },
    })
    const result = await queryLogs({ aws, request: request({ logGroups: ['/a', '/b'] }) })
    expect(result.missingPermissions).toEqual(['logs:FilterLogEvents'])
    expect(result.events).toHaveLength(1)
  })

  it('skips a group that does not exist without failing the search', async () => {
    const missing = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
    const { aws } = stubClient({
      filter: (group) =>
        group === '/a'
          ? missing
          : { events: [{ timestamp: T0, message: 'ok', logStreamName: 's', eventId: 'x' }] },
    })
    const result = await queryLogs({ aws, request: request({ logGroups: ['/a', '/b'] }) })
    expect(result.events).toHaveLength(1)
    expect(result.missingPermissions).toEqual([])
  })
})

describe('event shaping', () => {
  it('detects severity and parses a JSON message', () => {
    const event = toLogEvent(
      { timestamp: T0, message: '{"level":"ERROR","msg":"boom"}', logStreamName: 's', eventId: 'e' },
      '/a',
      0,
    )
    expect(event?.severity).toBe('error')
    expect(event?.json).toEqual({ level: 'ERROR', msg: 'boom' })
  })

  it('leaves json unset for a plain message rather than guessing', () => {
    const event = toLogEvent({ timestamp: T0, message: 'plain text', logStreamName: 's' }, '/a', 3)
    expect(event?.json).toBeUndefined()
    // No eventId from CloudWatch, so the id is derived and still unique.
    expect(event?.id).toBe('/a:' + T0 + ':3')
  })

  it('drops an event with no timestamp rather than dating it to now', () => {
    expect(toLogEvent({ message: 'orphan' }, '/a', 0)).toBeNull()
  })

  it('buckets the histogram per minute and leaves empty minutes out', () => {
    const events = [
      { timestamp: T0, id: '1' },
      { timestamp: T0 + 30_000, id: '2' },
      { timestamp: T0 + 120_000, id: '3' },
    ] as never
    const histogram = histogramOf(events)
    expect(histogram).toEqual([
      { t: T0, count: 2 },
      { t: T0 + 120_000, count: 1 },
    ])
  })
})
