import {
  choosePeriod,
  type CloudProvider,
  type MetricSeries,
} from '@cloudatlas/shared'

/**
 * Continuous metric updates over one connection.
 *
 * What "real time" can honestly mean here is bounded by CloudWatch, not by us.
 * A metric is published on a period — one minute for most services with
 * detailed monitoring, five without — and is then queryable only after an
 * ingestion delay. Polling faster than the period returns the same datapoint
 * again and bills for the privilege.
 *
 * So this does two things rather than one. It polls at a cadence derived from
 * the metric's own period and pushes only when a datapoint the client has not
 * seen actually lands. And it reports the age of the newest datapoint, so the
 * UI can show the lag it is really looking at instead of implying a freshness
 * that CloudWatch never offered. Measured, not claimed: the number comes from
 * the data, so it stays true when a resource is on basic monitoring or when
 * ingestion is slow.
 *
 * Logs are different and already better served: `StartLiveTail` is a genuine
 * push stream, so the log drawer does not poll at all.
 */

/** Never poll faster than this, whatever the period suggests. */
const MIN_INTERVAL_MS = 15_000

/** Nor slower, or a resource on a long period feels dead. */
const MAX_INTERVAL_MS = 60_000

export interface MetricStreamOptions {
  provider: CloudProvider
  nodeIds: string[]
  /** Empty means the primary metrics for each node's type. */
  metricNames: string[]
  /** How much history each update carries. */
  windowMs: number
  signal: AbortSignal
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface MetricStreamUpdate {
  type: 'metrics'
  nodeId: string
  series: MetricSeries[]
  /**
   * Age of the newest datapoint in this batch, in ms, or null when there is
   * none. This is the lag the reader is actually looking at.
   */
  lagMs: number | null
  missingPermissions: string[]
}

export type MetricStreamEvent = MetricStreamUpdate | { type: 'error'; message: string }

/** Newest timestamp that carries a value, ignoring trailing gaps. */
export function newestDatapoint(series: MetricSeries[]): number | null {
  let newest: number | null = null
  for (const entry of series) {
    for (let i = entry.values.length - 1; i >= 0; i--) {
      if (entry.values[i] === null) continue
      const timestamp = entry.timestamps[i]
      if (timestamp !== undefined && (newest === null || timestamp > newest)) newest = timestamp
      break
    }
  }
  return newest
}

/**
 * Poll cadence for a period, in ms.
 *
 * Half the period, so a new datapoint is picked up within half a cycle of
 * becoming available, clamped at both ends.
 */
export function intervalFor(periodSeconds: number): number {
  const half = (periodSeconds * 1000) / 2
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, half))
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function* streamMetrics(
  options: MetricStreamOptions,
): AsyncIterable<MetricStreamEvent> {
  const { provider, nodeIds, metricNames, windowMs, signal } = options
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? (() => Date.now())

  /** Newest datapoint already sent per node, so nothing is pushed twice. */
  const sent = new Map<string, number>()
  let interval = MIN_INTERVAL_MS

  while (!signal.aborted) {
    for (const nodeId of nodeIds) {
      if (signal.aborted) return
      const end = now()
      const start = end - windowMs
      const period = choosePeriod(start, end)
      interval = intervalFor(period)

      try {
        const response = await provider.getMetrics({
          nodeId,
          metricNames,
          start,
          end,
          period,
        })

        const newest = newestDatapoint(response.series)
        const previous = sent.get(nodeId)
        // The first update always goes out, so the client has something to
        // draw; after that only genuinely new data does.
        const isNew = previous === undefined || (newest !== null && newest > previous)
        if (!isNew) continue
        if (newest !== null) sent.set(nodeId, newest)
        else sent.set(nodeId, previous ?? 0)

        yield {
          type: 'metrics',
          nodeId,
          series: response.series,
          lagMs: newest === null ? null : Math.max(0, now() - newest),
          missingPermissions: response.missingPermissions,
        }
      } catch (error) {
        if (signal.aborted) return
        // One node failing must not end the stream for the others.
        yield {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (signal.aborted) return
    await sleep(interval)
  }
}
