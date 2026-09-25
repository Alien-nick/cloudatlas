import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { LOOKUP_RETENTION_MS, lookupChanges, resolveNodeId, toRecentChange } from './cloudtrail.js'

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0)

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'n', arn: null, type: 'rds', category: 'database', name: 'n', abbr: 'R',
    typeLabel: 'RDS instance', region: 'us-east-1', az: null, vpcId: null, subnetId: null,
    parentId: null, state: 'available', tags: [], props: [], raw: {}, logGroups: [],
    health: 'unknown', securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
    ...overrides,
  }
}

function stubClient(pagesByRegion: Record<string, unknown[]>): {
  aws: AwsClient
  inputs: Array<{ region: string; input: Record<string, unknown> }>
} {
  const inputs: Array<{ region: string; input: Record<string, unknown> }> = []
  const cursor: Record<string, number> = {}
  const aws = {
    async send(_s: string, region: string, _op: string, command: { input: Record<string, unknown> }) {
      inputs.push({ region, input: command.input })
      const pages = pagesByRegion[region] ?? []
      const index = cursor[region] ?? 0
      cursor[region] = index + 1
      const page = pages[index]
      if (page instanceof Error) throw page
      return page ?? { Events: [] }
    },
  } as unknown as AwsClient
  return { aws, inputs }
}

describe('matching an event to a resource', () => {
  const nodes = [
    node({ id: 'rds-1', name: 'prod-pg', arn: 'arn:aws:rds:us-east-1:111122223333:db:prod-pg' }),
    node({ id: 'rds-2', name: 'prod-pg-replica', type: 'rds' }),
    node({ id: 'ec2-1', name: 'web', type: 'ec2' }),
  ]

  it('matches on id, ARN, and name where the name is the identifier', () => {
    expect(resolveNodeId(['rds-1'], nodes)).toBe('rds-1')
    expect(resolveNodeId(['arn:aws:rds:us-east-1:111122223333:db:prod-pg'], nodes)).toBe('rds-1')
    expect(resolveNodeId(['prod-pg'], nodes)).toBe('rds-1')
  })

  it('does not match a near name', () => {
    // A wrong attribution sends the reader after the wrong deploy, which is
    // worse than showing the event unattached.
    expect(resolveNodeId(['prod-pg-old'], nodes)).toBeNull()
    expect(resolveNodeId(['prod'], nodes)).toBeNull()
  })

  it('does not match an EC2 instance by its Name tag', () => {
    // "web" is not a unique identifier for an instance the way a bucket name is.
    expect(resolveNodeId(['web'], nodes)).toBeNull()
  })

  it('leaves nodeId null rather than guessing', () => {
    const change = toRecentChange(
      {
        EventTime: new Date(NOW),
        EventName: 'UpdateFunctionCode',
        EventSource: 'lambda.amazonaws.com',
        Username: 'deploy-ci',
        Resources: [{ ResourceName: 'something-else' }],
      },
      'us-east-1',
      nodes,
    )
    expect(change?.nodeId).toBeNull()
    expect(change?.eventName).toBe('UpdateFunctionCode')
  })

  it('drops an event with no timestamp or name', () => {
    expect(toRecentChange({ EventName: 'X' }, 'us-east-1', nodes)).toBeNull()
    expect(toRecentChange({ EventTime: new Date(NOW) }, 'us-east-1', nodes)).toBeNull()
  })
})

describe('looking up changes', () => {
  it('asks only for write events', async () => {
    // Reads are the overwhelming majority and none of them changed anything.
    const { aws, inputs } = stubClient({ 'us-east-1': [{ Events: [] }] })
    await lookupChanges({ aws, regions: ['us-east-1'], nodes: [], start: NOW - 3_600_000, end: NOW, now: NOW })
    expect(inputs[0]?.input.LookupAttributes).toEqual([
      { AttributeKey: 'ReadOnly', AttributeValue: 'false' },
    ])
  })

  it('clamps a window past the 90-day retention', async () => {
    const { aws, inputs } = stubClient({ 'us-east-1': [{ Events: [] }] })
    await lookupChanges({
      aws, regions: ['us-east-1'], nodes: [],
      start: NOW - 365 * 24 * 3_600_000, end: NOW, now: NOW,
    })
    const startTime = inputs[0]?.input.StartTime as Date
    expect(startTime.getTime()).toBe(NOW - LOOKUP_RETENTION_MS)
  })

  it('merges regions newest first, because a timeline is read backwards', async () => {
    const { aws } = stubClient({
      'us-east-1': [{ Events: [{ EventTime: new Date(NOW - 60_000), EventName: 'A' }] }],
      'us-west-2': [{ Events: [{ EventTime: new Date(NOW - 10_000), EventName: 'B' }] }],
    })
    const changes = await lookupChanges({
      aws, regions: ['us-east-1', 'us-west-2'], nodes: [],
      start: NOW - 3_600_000, end: NOW, now: NOW,
    })
    expect(changes.map((change) => change.eventName)).toEqual(['B', 'A'])
  })

  it('keeps the other regions when one trail is denied', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    const { aws } = stubClient({
      'us-east-1': [denied],
      'us-west-2': [{ Events: [{ EventTime: new Date(NOW), EventName: 'B' }] }],
    })
    const warnings: string[] = []
    const changes = await lookupChanges({
      aws, regions: ['us-east-1', 'us-west-2'], nodes: [],
      start: NOW - 3_600_000, end: NOW, now: NOW,
      onWarning: (action) => warnings.push(action),
    })
    expect(changes).toHaveLength(1)
    expect(warnings).toEqual(['cloudtrail:LookupEvents'])
  })

  it('stops paging at the bound rather than walking a busy account forever', async () => {
    const page = { Events: [{ EventTime: new Date(NOW), EventName: 'A' }], NextToken: 'more' }
    const { aws, inputs } = stubClient({ 'us-east-1': Array.from({ length: 50 }, () => page) })
    await lookupChanges({ aws, regions: ['us-east-1'], nodes: [], start: NOW - 3_600_000, end: NOW, now: NOW })
    expect(inputs.length).toBeLessThanOrEqual(10)
  })
})
