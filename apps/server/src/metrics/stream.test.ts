import { describe, expect, it } from 'vitest'
import type { CloudProvider, MetricSeries } from '@cloudatlas/shared'
import { intervalFor, newestDatapoint, streamMetrics, type MetricStreamEvent } from './stream.js'

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0)
const MINUTE = 60_000

function series(values: Array<number | null>, from = T0): MetricSeries {
  return {
    nodeId: 'db',
    metricName: 'CPUUtilization',
    namespace: 'AWS/RDS',
    label: 'CPU utilization',
    unit: '%',
    stat: 'Average',
    timestamps: values.map((_, i) => from + i * MINUTE),
    values,
    period: 60,
    unavailableReason: null,
  }
}

/** Returns a scripted response per call, then repeats the last. */
function stubProvider(responses: MetricSeries[][]): {
  provider: CloudProvider
  calls: number
} {
  let index = 0
  const state = { calls: 0 }
  const provider = {
    async getMetrics() {
      state.calls++
      const batch = responses[Math.min(index++, responses.length - 1)] ?? []
      return { series: batch, missingPermissions: [] }
    },
  } as unknown as CloudProvider
  return {
    provider,
    get calls() {
      return state.calls
    },
  } as { provider: CloudProvider; calls: number }
}

async function take(
  stream: AsyncIterable<MetricStreamEvent>,
  count: number,
  controller: AbortController,
): Promise<MetricStreamEvent[]> {
  const out: MetricStreamEvent[] = []
  for await (const event of stream) {
    out.push(event)
    if (out.length >= count) {
      controller.abort()
      break
    }
  }
  return out
}

describe('poll cadence', () => {
  it('derives from the metric period rather than a fixed timer', () => {
    // Half the period, so a new datapoint is picked up within half a cycle.
    expect(intervalFor(60)).toBe(30_000)
    expect(intervalFor(300)).toBe(60_000)
  })

  it('clamps at both ends', () => {
    // Never faster than 15s — CloudWatch will not have anything new — and
    // never slower than 60s, or a long-period resource feels dead.
    expect(intervalFor(1)).toBe(15_000)
    expect(intervalFor(86_400)).toBe(60_000)
  })
})

describe('finding the newest datapoint', () => {
  it('ignores trailing gaps, which are the normal end of a window', () => {
    // The last slot is almost always empty: CloudWatch has not published it
    // yet. Reading the last timestamp rather than the last *value* would
    // report a lag of zero on a chart that is minutes behind.
    const newest = newestDatapoint([series([1, 2, 3, null, null])])
    expect(newest).toBe(T0 + 2 * MINUTE)
  })

  it('takes the newest across several metrics', () => {
    const a = series([1, null, null])
    const b = series([1, 2, 3])
    expect(newestDatapoint([a, b])).toBe(T0 + 2 * MINUTE)
  })

  it('is null when nothing has a value', () => {
    expect(newestDatapoint([series([null, null])])).toBeNull()
    expect(newestDatapoint([])).toBeNull()
  })
})

describe('streaming', () => {
  const noSleep = async (): Promise<void> => {}

  it('sends the first update immediately, so the chart is not empty', async () => {
    const { provider } = stubProvider([[series([1, 2, 3])]])
    const controller = new AbortController()
    const events = await take(
      streamMetrics({
        provider,
        nodeIds: ['db'],
        metricNames: [],
        windowMs: 3_600_000,
        signal: controller.signal,
        sleep: noSleep,
        now: () => T0 + 3 * MINUTE,
      }),
      1,
      controller,
    )
    expect(events[0]?.type).toBe('metrics')
  })

  it('pushes nothing when CloudWatch has not published anything new', async () => {
    // The point of the change check: the old 15-second timer re-fetched and
    // re-rendered the same datapoint four times out of five.
    const same = [series([1, 2, 3])]
    const { provider } = stubProvider([same, same, same])
    const controller = new AbortController()

    const events: MetricStreamEvent[] = []
    // Counted by poll cycle, not by event: aborting after the first event
    // cannot tell "pushed once" from "pushed every cycle".
    let cycles = 0
    const stream = streamMetrics({
      provider,
      nodeIds: ['db'],
      metricNames: [],
      windowMs: 3_600_000,
      signal: controller.signal,
      sleep: async () => {
        cycles++
        if (cycles >= 4) controller.abort()
      },
      now: () => T0 + 3 * MINUTE,
    })
    for await (const event of stream) events.push(event)

    expect(cycles).toBeGreaterThanOrEqual(4)
    // Four polls, one update: the other three found nothing new.
    expect(events).toHaveLength(1)
  })

  it('pushes again once a newer datapoint lands', async () => {
    const { provider } = stubProvider([[series([1, 2, 3])], [series([1, 2, 3, 4])]])
    const controller = new AbortController()
    const events = await take(
      streamMetrics({
        provider,
        nodeIds: ['db'],
        metricNames: [],
        windowMs: 3_600_000,
        signal: controller.signal,
        sleep: noSleep,
        now: () => T0 + 4 * MINUTE,
      }),
      2,
      controller,
    )
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.type === 'metrics')).toBe(true)
  })

  it('reports the measured lag, not an assumed one', async () => {
    // The newest datapoint is two minutes old, and that is what the reader
    // needs to know — "live" without a number invites assuming now.
    const { provider } = stubProvider([[series([1, 2, 3])]])
    const controller = new AbortController()
    const [event] = await take(
      streamMetrics({
        provider,
        nodeIds: ['db'],
        metricNames: [],
        windowMs: 3_600_000,
        signal: controller.signal,
        sleep: noSleep,
        now: () => T0 + 4 * MINUTE,
      }),
      1,
      controller,
    )
    expect(event?.type === 'metrics' && event.lagMs).toBe(2 * MINUTE)
  })

  it('keeps streaming when one resource fails', async () => {
    let call = 0
    const provider = {
      async getMetrics({ nodeId }: { nodeId: string }) {
        call++
        if (nodeId === 'broken') throw new Error('that one is denied')
        return { series: [series([1, 2, 3])], missingPermissions: [] }
      },
    } as unknown as CloudProvider

    const controller = new AbortController()
    const events = await take(
      streamMetrics({
        provider,
        nodeIds: ['broken', 'db'],
        metricNames: [],
        windowMs: 3_600_000,
        signal: controller.signal,
        sleep: noSleep,
        now: () => T0 + 3 * MINUTE,
      }),
      2,
      controller,
    )
    expect(events[0]).toEqual({ type: 'error', message: 'that one is denied' })
    expect(events[1]?.type).toBe('metrics')
    expect(call).toBeGreaterThan(1)
  })

  it('stops promptly when the client disconnects', async () => {
    const { provider } = stubProvider([[series([1, 2, 3])]])
    const controller = new AbortController()
    controller.abort()

    const events: MetricStreamEvent[] = []
    for await (const event of streamMetrics({
      provider,
      nodeIds: ['db'],
      metricNames: [],
      windowMs: 3_600_000,
      signal: controller.signal,
      sleep: noSleep,
    })) {
      events.push(event)
    }
    expect(events).toEqual([])
  })
})
