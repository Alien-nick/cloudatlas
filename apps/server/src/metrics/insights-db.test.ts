import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import {
  dbiResourceIdOf,
  getDatabaseLoad,
  performanceInsightsEnabled,
  vcpusOf,
} from './insights-db.js'

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0)

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'prod-pg', arn: null, type: 'rds', category: 'database', name: 'prod-pg', abbr: 'R',
    typeLabel: 'RDS instance', region: 'us-east-1', az: null, vpcId: null, subnetId: null,
    parentId: null, state: 'available',
    tags: [], raw: { DbiResourceId: 'db-ABCDEFGHIJKLMNOP' }, logGroups: [], health: 'unknown',
    securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
    props: [
      { k: 'Performance Insights', v: 'enabled · 7 day retention', mono: false },
      { k: 'Instance class', v: 'db.r6g.2xlarge · 8 vCPU / 64 GiB', mono: true },
    ],
    ...overrides,
  }
}

function stubClient(responses: Record<string, unknown>): {
  aws: AwsClient
  inputs: Array<Record<string, unknown>>
} {
  const inputs: Array<Record<string, unknown>> = []
  const aws = {
    async send(_s: string, _r: string, operation: string, command: { input: Record<string, unknown> }) {
      inputs.push({ operation, ...command.input })
      const result = responses[operation === 'GetResourceMetrics' ? 'metrics' : String(command.input.GroupBy && (command.input.GroupBy as { Group: string }).Group)]
      if (result instanceof Error) throw result
      return result ?? {}
    },
  } as unknown as AwsClient
  return { aws, inputs }
}

describe('preconditions', () => {
  it('reads the DbiResourceId, which is what the API wants', () => {
    // Not the DB instance identifier: passing that returns a confusing error
    // about an unknown resource.
    expect(dbiResourceIdOf(node())).toBe('db-ABCDEFGHIJKLMNOP')
    expect(dbiResourceIdOf(node({ raw: { DbiResourceId: 'prod-pg' } }))).toBeNull()
    expect(dbiResourceIdOf(node({ raw: {} }))).toBeNull()
  })

  it('detects whether Performance Insights is on', () => {
    expect(performanceInsightsEnabled(node())).toBe(true)
    expect(
      performanceInsightsEnabled(
        node({ props: [{ k: 'Performance Insights', v: 'disabled', mono: false }] }),
      ),
    ).toBe(false)
  })

  it('parses the vCPU count, which is the line load is read against', () => {
    expect(vcpusOf(node())).toBe(8)
    expect(vcpusOf(node({ props: [{ k: 'Instance class', v: 'db.t3.medium', mono: true }] }))).toBeNull()
  })

  it('refuses without calling AWS when a precondition fails', async () => {
    const { aws, inputs } = stubClient({})

    const notRds = await getDatabaseLoad({ aws, node: node({ type: 'ec2' }), start: 0, end: NOW })
    expect(notRds.unavailableReason).toMatch(/only available for RDS/)

    const off = await getDatabaseLoad({
      aws,
      node: node({ props: [{ k: 'Performance Insights', v: 'disabled', mono: false }] }),
      start: 0,
      end: NOW,
    })
    expect(off.unavailableReason).toMatch(/not enabled/)

    const noId = await getDatabaseLoad({ aws, node: node({ raw: {} }), start: 0, end: NOW })
    expect(noId.unavailableReason).toMatch(/DbiResourceId/)

    // No wasted calls, and no misleading error from AWS.
    expect(inputs).toEqual([])
  })
})

describe('reading the breakdown', () => {
  const responses = {
    metrics: { MetricList: [{ DataPoints: [{ Value: 12 }, { Value: 16 }, { Value: 14 }] }] },
    'db.sql_tokenized': {
      Keys: [
        { Total: 8, Dimensions: { 'db.sql_tokenized.statement': 'SELECT * FROM appointments WHERE id = ?' } },
        { Total: 2, Dimensions: { 'db.sql_tokenized.statement': 'UPDATE encounters SET status = ?' } },
        // Below the 1% floor: noise in a top-N list.
        { Total: 0.02, Dimensions: { 'db.sql_tokenized.statement': 'SELECT 1' } },
      ],
    },
    'db.wait_event': {
      Keys: [{ Total: 6, Dimensions: { 'db.wait_event.name': 'LWLock:BufferContent' } }],
    },
  }

  it('averages load and ranks statements and waits by share', async () => {
    const { aws } = stubClient(responses)
    const load = await getDatabaseLoad({ aws, node: node(), start: NOW - 3_600_000, end: NOW })

    expect(load.averageLoad).toBe(14)
    expect(load.vcpus).toBe(8)
    expect(load.topSql[0]?.label).toMatch(/appointments/)
    expect(load.topSql[0]?.share).toBeCloseTo(0.8, 2)
    expect(load.topSql).toHaveLength(2)
    expect(load.topWaits[0]?.label).toBe('LWLock:BufferContent')
    expect(load.unavailableReason).toBeNull()
  })

  it('sends the resource id, not the instance name', async () => {
    const { aws, inputs } = stubClient(responses)
    await getDatabaseLoad({ aws, node: node(), start: NOW - 3_600_000, end: NOW })
    for (const input of inputs) expect(input.Identifier).toBe('db-ABCDEFGHIJKLMNOP')
  })

  it('truncates a very long statement rather than returning kilobytes', async () => {
    const long = `SELECT ${'x'.repeat(2000)}`
    const { aws } = stubClient({
      ...responses,
      'db.sql_tokenized': { Keys: [{ Total: 5, Dimensions: { 'db.sql_tokenized.statement': long } }] },
    })
    const load = await getDatabaseLoad({ aws, node: node(), start: 0, end: NOW })
    expect(load.topSql[0]?.label.length).toBeLessThan(410)
    expect(load.topSql[0]?.label.endsWith('…')).toBe(true)
  })

  it('explains an empty window instead of reporting an idle database', async () => {
    // Outside the retention period returns nothing, not an error — which is
    // indistinguishable from "the database was doing nothing".
    const { aws } = stubClient({ metrics: {}, 'db.sql_tokenized': {}, 'db.wait_event': {} })
    const load = await getDatabaseLoad({ aws, node: node(), start: 0, end: NOW })
    expect(load.unavailableReason).toMatch(/retention period, or the instance may have been idle/)
  })

  it('names a missing permission rather than failing the panel', async () => {
    const denied = Object.assign(new Error('nope'), {
      name: 'AccessDeniedException',
      action: 'pi:DescribeDimensionKeys',
    })
    const { aws } = stubClient({ metrics: denied, 'db.sql_tokenized': denied, 'db.wait_event': denied })
    const load = await getDatabaseLoad({ aws, node: node(), start: 0, end: NOW })
    expect(load.unavailableReason).toMatch(/Missing permission: pi:DescribeDimensionKeys/)
  })
})
