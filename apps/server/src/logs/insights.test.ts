import { describe, expect, it } from 'vitest'
import type { InsightsRequest } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { columnsOf, normalizeStatus, queryInsights, toRows } from './insights.js'

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0)

function request(overrides: Partial<InsightsRequest> = {}): InsightsRequest {
  return {
    logGroups: ['/aws/rds/instance/db/postgresql'],
    region: 'us-east-1',
    query: 'fields @timestamp, @message | limit 20',
    start: T0,
    end: T0 + 3_600_000,
    limit: 1000,
    ...overrides,
  }
}

/** Replays a scripted sequence of GetQueryResults statuses. */
function stubClient(statuses: Array<Record<string, unknown>>): {
  aws: AwsClient
  ops: string[]
  inputs: Array<Record<string, unknown>>
} {
  const ops: string[] = []
  const inputs: Array<Record<string, unknown>> = []
  let poll = 0
  const aws = {
    async send(_s: string, _r: string, operation: string, command: { input: Record<string, unknown> }) {
      ops.push(operation)
      inputs.push(command.input)
      if (operation === 'StartQuery') return { queryId: 'q-1' }
      if (operation === 'GetQueryResults') return statuses[Math.min(poll++, statuses.length - 1)] ?? {}
      return {}
    },
  } as unknown as AwsClient
  return { aws, ops, inputs }
}

const noSleep = async (): Promise<void> => {}

describe('status mapping', () => {
  it('folds Scheduled into Running, because the caller cannot act on the difference', () => {
    expect(normalizeStatus('Scheduled')).toBe('Running')
    expect(normalizeStatus('Running')).toBe('Running')
  })

  it('reports an unrecognised status as a failure, not a complete empty result', () => {
    expect(normalizeStatus('Unknown')).toBe('Failed')
    expect(normalizeStatus(undefined)).toBe('Failed')
  })

  it('passes the terminal statuses through', () => {
    for (const status of ['Complete', 'Failed', 'Timeout', 'Cancelled']) {
      expect(normalizeStatus(status)).toBe(status)
    }
  })
})

describe('result shaping', () => {
  const raw = [
    [
      { field: '@timestamp', value: '2026-09-21 12:00:00' },
      { field: '@message', value: 'hello' },
      { field: '@ptr', value: 'CnQKOwo3...' },
    ],
    [
      { field: '@timestamp', value: '2026-09-21 12:00:01' },
      { field: '@message', value: 'world' },
      { field: '@ptr', value: 'CnQKOwo4...' },
    ],
  ]

  it('takes column order from the query, since Insights gives no schema', () => {
    expect(columnsOf(raw)).toEqual(['@timestamp', '@message'])
  })

  it('drops @ptr, which is an opaque cursor rather than a value', () => {
    expect(columnsOf(raw)).not.toContain('@ptr')
    expect(toRows(raw)[0]).toEqual({ '@timestamp': '2026-09-21 12:00:00', '@message': 'hello' })
  })

  it('picks up a column that only appears in a later row', () => {
    const sparse = [[{ field: 'a', value: '1' }], [{ field: 'b', value: '2' }]]
    expect(columnsOf(sparse)).toEqual(['a', 'b'])
  })
})

describe('running a query', () => {
  it('converts the window to seconds, which is what Insights expects', async () => {
    const { aws, inputs } = stubClient([{ status: 'Complete', results: [] }])
    await queryInsights({ aws, request: request(), sleep: noSleep })
    // Passing epoch milliseconds here is the classic way to get an empty
    // result set from a query that is otherwise fine.
    expect(inputs[0]?.startTime).toBe(Math.floor(T0 / 1000))
    expect(inputs[0]?.endTime).toBe(Math.floor((T0 + 3_600_000) / 1000))
  })

  it('polls until the status settles', async () => {
    const { aws, ops } = stubClient([
      { status: 'Scheduled' },
      { status: 'Running' },
      { status: 'Complete', results: [[{ field: 'a', value: '1' }]] },
    ])
    const result = await queryInsights({ aws, request: request(), sleep: noSleep })
    expect(result.status).toBe('Complete')
    expect(result.rows).toEqual([{ a: '1' }])
    expect(ops.filter((op) => op === 'GetQueryResults')).toHaveLength(3)
    // Terminal status reached, so nothing to stop.
    expect(ops).not.toContain('StopQuery')
  })

  it('stops a query it gives up waiting on, so it stops scanning and billing', async () => {
    const { aws, ops } = stubClient([{ status: 'Running', results: [[{ field: 'a', value: '1' }]] }])
    const result = await queryInsights({
      aws,
      request: request(),
      timeoutMs: 1,
      sleep: noSleep,
    })
    expect(ops).toContain('StopQuery')
    expect(result.status).toBe('Timeout')
    // Partial rows are returned rather than discarded.
    expect(result.rows).toEqual([{ a: '1' }])
    // And the reason says who stopped it, which 'Timeout' alone does not.
    expect(result.error).toMatch(/CloudAtlas stopped the query/)
  })

  it('distinguishes an AWS timeout from one of ours', async () => {
    const { aws } = stubClient([{ status: 'Timeout', results: [] }])
    const result = await queryInsights({ aws, request: request(), sleep: noSleep })
    expect(result.error).toMatch(/CloudWatch timed out/)
    expect(result.error).not.toMatch(/CloudAtlas stopped/)
  })

  it('explains a failed query instead of showing an empty table', async () => {
    const { aws } = stubClient([{ status: 'Failed', results: [] }])
    const result = await queryInsights({ aws, request: request(), sleep: noSleep })
    expect(result.status).toBe('Failed')
    expect(result.error).toMatch(/query syntax/)
  })

  it('stops the query when the caller goes away', async () => {
    const controller = new AbortController()
    controller.abort()
    const { aws, ops } = stubClient([{ status: 'Running' }])
    const result = await queryInsights({
      aws,
      request: request(),
      signal: controller.signal,
      sleep: noSleep,
    })
    expect(ops).toContain('StopQuery')
    expect(result.error).toMatch(/cancelled/)
  })

  it('reports statistics when CloudWatch provides them', async () => {
    const { aws } = stubClient([
      {
        status: 'Complete',
        results: [],
        statistics: { recordsMatched: 12, recordsScanned: 3400, bytesScanned: 918_273 },
      },
    ])
    const result = await queryInsights({ aws, request: request(), sleep: noSleep })
    expect(result.statistics).toEqual({
      recordsMatched: 12,
      recordsScanned: 3400,
      bytesScanned: 918_273,
    })
  })

  it('fails clearly when StartQuery returns no id', async () => {
    const aws = {
      async send(_s: string, _r: string, operation: string) {
        return operation === 'StartQuery' ? {} : {}
      },
    } as unknown as AwsClient
    const result = await queryInsights({ aws, request: request(), sleep: noSleep })
    expect(result.status).toBe('Failed')
    expect(result.error).toMatch(/no query id/)
  })
})
