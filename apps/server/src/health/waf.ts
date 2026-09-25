import {
  GetSampledRequestsCommand,
  type GetSampledRequestsResponse,
  type SampledHTTPRequest,
  type Scope,
} from '@aws-sdk/client-wafv2'
import type {
  WafSampledRequest,
  WafSampledRequestsRequest,
  WafSampledResponse,
} from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Sampled requests for a web ACL.
 *
 * WAF does not keep full request logs here — `GetSampledRequests` returns a
 * sample from the last three hours, and each sampled request carries a
 * `Weight` saying how many real requests it stands for. Counting samples
 * instead of summing weights understates a spike by whatever the sampling
 * ratio happened to be, which is exactly the number someone is trying to read
 * during an incident.
 *
 * The three-hour retention is a hard edge: a window further back returns an
 * empty list rather than an error, so it is clamped and the caller is told.
 */

/** WAF keeps samples for three hours. */
export const SAMPLE_RETENTION_MS = 3 * 60 * 60 * 1000

/** Hard API cap per rule per call. */
const MAX_ITEMS = 500

export interface SampledOptions {
  aws: AwsClient
  request: WafSampledRequestsRequest
  /** From the web ACL node. */
  webAclArn: string
  region: string
  scope: Scope
  /** Metric names of the rules to sample; `ALL` covers the whole ACL. */
  ruleMetricNames: string[]
  now?: number
}

export interface ClampedWindow {
  startTime: Date
  endTime: Date
  /** Set when the requested window had to be moved. */
  note: string | null
}

/**
 * Clamp a requested window into what WAF will actually answer for.
 *
 * Returning a note rather than silently adjusting matters: an empty result for
 * a window WAF never held looks identical to "no requests were blocked".
 */
export function clampWindow(start: number, end: number, now: number): ClampedWindow {
  const earliest = now - SAMPLE_RETENTION_MS
  const clampedStart = Math.max(start, earliest)
  const clampedEnd = Math.min(end, now)
  const moved = clampedStart !== start || clampedEnd !== end
  return {
    startTime: new Date(clampedStart),
    endTime: new Date(Math.max(clampedEnd, clampedStart + 1000)),
    note: moved
      ? 'WAF keeps sampled requests for three hours; the window was clamped to what it retains.'
      : null,
  }
}

function toSampled(sample: SampledHTTPRequest, fallbackRule: string): WafSampledRequest | null {
  const request = sample.Request
  const timestamp = sample.Timestamp?.getTime()
  if (!request || timestamp === undefined) return null
  return {
    timestamp,
    clientIp: request.ClientIP ?? 'unknown',
    country: request.Country ?? 'unknown',
    uri: request.URI ?? '/',
    method: request.Method ?? 'GET',
    action: sample.Action ?? 'UNKNOWN',
    ruleName: sample.RuleNameWithinRuleGroup ?? fallbackRule,
    // Each sample stands for `Weight` real requests.
    weight: sample.Weight ?? 1,
  }
}

/** Top 25 by summed weight, which is the real request count. */
export function tally(
  requests: WafSampledRequest[],
  key: (request: WafSampledRequest) => string,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>()
  for (const request of requests) {
    const bucket = key(request)
    counts.set(bucket, (counts.get(bucket) ?? 0) + request.weight)
  }
  return [...counts.entries()]
    .map(([entry, count]) => ({ key: entry, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 25)
}

export async function getWafSampled(options: SampledOptions): Promise<WafSampledResponse> {
  const { aws, request, webAclArn, region, scope, ruleMetricNames } = options
  const now = options.now ?? Date.now()
  const window = clampWindow(request.start, request.end, now)

  const requests: WafSampledRequest[] = []
  for (const metricName of ruleMetricNames) {
    const output: GetSampledRequestsResponse = await aws.send(
      'wafv2',
      region,
      'GetSampledRequests',
      new GetSampledRequestsCommand({
        WebAclArn: webAclArn,
        RuleMetricName: metricName,
        Scope: scope,
        TimeWindow: { StartTime: window.startTime, EndTime: window.endTime },
        MaxItems: MAX_ITEMS,
      }),
    )
    for (const sample of output.SampledRequests ?? []) {
      const mapped = toSampled(sample, metricName)
      if (mapped) requests.push(mapped)
    }
  }

  requests.sort((a, b) => a.timestamp - b.timestamp)

  return {
    requests,
    byRule: tally(requests, (entry) => entry.ruleName),
    byClientIp: tally(requests, (entry) => entry.clientIp),
    byCountry: tally(requests, (entry) => entry.country),
    byUri: tally(requests, (entry) => entry.uri),
  }
}
