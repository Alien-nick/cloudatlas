import { describe, expect, it } from 'vitest'
import type { AwsClient } from '../aws/client.js'
import { LiveTailError, logGroupArn, tailLogs } from './tail.js'

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0)

/** Replays a scripted sequence of response-stream frames. */
function stubClient(frames: unknown[]): { aws: AwsClient; destroyed: () => boolean } {
  let destroyed = false
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame
    },
    destroy() {
      destroyed = true
    },
  }
  const aws = {
    async send() {
      return { responseStream: stream }
    },
  } as unknown as AwsClient
  return { aws, destroyed: () => destroyed }
}

function options(aws: AwsClient, signal = new AbortController().signal) {
  return {
    aws,
    accountId: '111122223333',
    region: 'us-east-1',
    logGroups: ['/aws/lambda/worker'],
    filterPattern: '',
    signal,
  }
}

async function collect(stream: AsyncIterable<unknown[]>): Promise<unknown[][]> {
  const out: unknown[][] = []
  for await (const batch of stream) out.push(batch)
  return out
}

describe('log group ARNs', () => {
  it('builds one from a name, which the API requires', () => {
    // Unlike FilterLogEvents, live tail rejects plain group names.
    expect(logGroupArn('/aws/lambda/worker', 'us-east-1', '111122223333')).toBe(
      'arn:aws:logs:us-east-1:111122223333:log-group:/aws/lambda/worker',
    )
  })

  it('leaves an ARN alone rather than wrapping it twice', () => {
    const arn = 'arn:aws:logs:eu-west-1:111122223333:log-group:/custom'
    expect(logGroupArn(arn, 'us-east-1', '111122223333')).toBe(arn)
  })
})

describe('tailing', () => {
  it('does not emit the handshake frame as an empty batch', async () => {
    const { aws } = stubClient([
      { sessionStart: { sessionId: 's-1' } },
      {
        sessionUpdate: {
          sessionResults: [
            { timestamp: T0, message: 'ERROR boom', logStreamName: 'a', logGroupIdentifier: 'g' },
          ],
        },
      },
    ])
    const batches = await collect(tailLogs(options(aws)))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
  })

  it('detects severity on streamed events', async () => {
    const { aws } = stubClient([
      {
        sessionUpdate: {
          sessionResults: [
            { timestamp: T0, message: 'ERROR boom', logStreamName: 'a' },
            { timestamp: T0 + 1, message: 'all fine', logStreamName: 'a' },
          ],
        },
      },
    ])
    const [batch] = await collect(tailLogs(options(aws)))
    expect((batch as Array<{ severity: string | null }>)[0]?.severity).toBe('error')
    expect((batch as Array<{ severity: string | null }>)[1]?.severity).toBeNull()
  })

  it('skips an update that carries no usable events', async () => {
    const { aws } = stubClient([
      { sessionUpdate: { sessionResults: [] } },
      { sessionUpdate: { sessionResults: [{ message: 'no timestamp' }] } },
    ])
    expect(await collect(tailLogs(options(aws)))).toEqual([])
  })

  it('surfaces the throughput ceiling as an error, not a silent stop', async () => {
    // Without this the tail just stops and the drawer looks idle.
    const { aws } = stubClient([
      { SessionStreamingException: { message: 'Rate exceeded for this session' } },
    ])
    await expect(collect(tailLogs(options(aws)))).rejects.toThrow(LiveTailError)
    await expect(collect(tailLogs(options(aws)))).rejects.toThrow(/Rate exceeded/)
  })

  it('explains the three-hour session limit', async () => {
    const { aws } = stubClient([{ SessionTimeoutException: {} }])
    await expect(collect(tailLogs(options(aws)))).rejects.toThrow(/3-hour limit/)
  })

  it('destroys the stream when the consumer stops, so the session ends', async () => {
    // Dropping the iterator is not enough: the session stays open until the
    // 3-hour limit, holding a connection and a concurrent-session slot.
    const { aws, destroyed } = stubClient([
      { sessionUpdate: { sessionResults: [{ timestamp: T0, message: 'one', logStreamName: 'a' }] } },
      { sessionUpdate: { sessionResults: [{ timestamp: T0 + 1, message: 'two', logStreamName: 'a' }] } },
    ])
    const iterator = tailLogs(options(aws))[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.(undefined)
    expect(destroyed()).toBe(true)
  })

  it('stops promptly when the request is aborted', async () => {
    const controller = new AbortController()
    const { aws } = stubClient([
      { sessionUpdate: { sessionResults: [{ timestamp: T0, message: 'one', logStreamName: 'a' }] } },
      { sessionUpdate: { sessionResults: [{ timestamp: T0 + 1, message: 'two', logStreamName: 'a' }] } },
    ])
    controller.abort()
    expect(await collect(tailLogs(options(aws, controller.signal)))).toEqual([])
  })

  it('fails clearly when CloudWatch returns no stream at all', async () => {
    const aws = { async send() { return {} } } as unknown as AwsClient
    await expect(collect(tailLogs(options(aws)))).rejects.toThrow(/no live tail stream/)
  })
})
