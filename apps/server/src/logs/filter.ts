import {
  FilterLogEventsCommand,
  type FilteredLogEvent,
  type FilterLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs'
import {
  detectSeverity,
  type LogEvent,
  type LogQueryRequest,
  type LogQueryResponse,
} from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Log search over one or more groups.
 *
 * `FilterLogEvents` takes a single log group per call, so a search across three
 * groups is three paginated calls merged by timestamp. That is also why the
 * limit is divided between them: asking each group for the full limit and then
 * truncating would quietly bias the result toward whichever group happened to
 * return first.
 */

/** Bucket width for the histogram above the results. */
const BUCKET_MS = 60_000

/**
 * Decide whether the user typed a CloudWatch filter pattern or a plain string.
 *
 * This is the one genuinely ambiguous input in the log drawer. CloudWatch's
 * filter syntax gives `{ $.level = "ERROR" }` and `[ip, user, ...]` special
 * meaning, and treating a bare word as a pattern mostly works — but a search
 * for `error:` or `5xx` is not valid pattern syntax and CloudWatch answers with
 * an InvalidParameterException rather than no results.
 *
 * So anything that is not recognisably pattern syntax is quoted, which is the
 * documented way to ask for a literal substring. A user who wants pattern
 * syntax gets it by using pattern syntax.
 */
export function toFilterPattern(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) return ''

  // Already a JSON or space-delimited pattern, or already quoted.
  const first = trimmed[0]
  if (first === '{' || first === '[' || first === '"') return trimmed
  // A multi-term pattern using CloudWatch's ?/- operators.
  if (/^[?-]\s*\S/.test(trimmed)) return trimmed

  // Escape embedded quotes so the literal stays one term.
  return `"${trimmed.replace(/"/g, '\\"')}"`
}

/** Stable id: a CloudWatch event id when present, otherwise position-derived. */
function eventId(event: FilteredLogEvent, group: string, index: number): string {
  return event.eventId ?? `${group}:${event.timestamp ?? 0}:${index}`
}

/** Parse the message as JSON when it is, for the expandable row view. */
function parseJson(message: string): unknown {
  const trimmed = message.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function toLogEvent(event: FilteredLogEvent, group: string, index: number): LogEvent | null {
  const timestamp = event.timestamp
  const message = event.message
  if (timestamp === undefined || message === undefined) return null
  const json = parseJson(message)
  return {
    id: eventId(event, group, index),
    timestamp,
    message,
    logGroup: group,
    logStream: event.logStreamName ?? '',
    severity: detectSeverity(message),
    ...(json === undefined ? {} : { json }),
  }
}

/** Per-minute counts, with empty buckets left out rather than zero-filled. */
export function histogramOf(events: LogEvent[]): Array<{ t: number; count: number }> {
  const buckets = new Map<number, number>()
  for (const event of events) {
    const bucket = Math.floor(event.timestamp / BUCKET_MS) * BUCKET_MS
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  return [...buckets.entries()].map(([t, count]) => ({ t, count })).sort((a, b) => a.t - b.t)
}

export interface QueryLogsOptions {
  aws: AwsClient
  request: LogQueryRequest
}

export async function queryLogs(options: QueryLogsOptions): Promise<LogQueryResponse> {
  const { aws, request } = options
  const groups = request.logGroups
  const pattern = toFilterPattern(request.filterPattern)
  const perGroupLimit = Math.max(1, Math.floor(request.limit / groups.length))

  const events: LogEvent[] = []
  const missingPermissions: string[] = []
  let truncated = false

  for (const group of groups) {
    try {
      let token: string | undefined
      let collected = 0
      do {
        const output: FilterLogEventsCommandOutput = await aws.send(
          'logs',
          request.region,
          'FilterLogEvents',
          new FilterLogEventsCommand({
            logGroupName: group,
            startTime: request.start,
            endTime: request.end,
            ...(pattern ? { filterPattern: pattern } : {}),
            limit: Math.min(10_000, perGroupLimit - collected),
            nextToken: token,
          }),
        )

        for (const [index, raw] of (output.events ?? []).entries()) {
          const event = toLogEvent(raw, group, collected + index)
          if (event) events.push(event)
        }
        collected += output.events?.length ?? 0
        token = output.nextToken

        // A remaining token past the limit means there was more to see; say so
        // rather than presenting a clipped result as the whole answer.
        if (collected >= perGroupLimit) {
          truncated ||= token !== undefined
          break
        }
      } while (token)
    } catch (error) {
      const err = error as Error & { action?: string }
      if (err.name === 'AccessDeniedException') {
        const action = err.action ?? 'logs:FilterLogEvents'
        if (!missingPermissions.includes(action)) missingPermissions.push(action)
        continue
      }
      if (err.name === 'ResourceNotFoundException') {
        // The group was listed but does not exist. Not an error worth failing
        // the whole search for — the picker already says it is missing.
        continue
      }
      throw error
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const clipped = events.length > request.limit
  const finalEvents = clipped ? events.slice(-request.limit) : events

  return {
    events: finalEvents,
    truncated: truncated || clipped,
    // The histogram counts everything fetched, including rows the limit trimmed
    // from the list — otherwise the chart would disagree with "truncated".
    histogram: histogramOf(events),
    missingPermissions,
  }
}
