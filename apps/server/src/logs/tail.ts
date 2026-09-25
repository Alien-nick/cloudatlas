import {
  StartLiveTailCommand,
  type StartLiveTailCommandOutput,
  type StartLiveTailResponseStream,
} from '@aws-sdk/client-cloudwatch-logs'
import { detectSeverity, type LogEvent, type TailOptions } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Live tail.
 *
 * `StartLiveTail` is the only streaming call CloudAtlas makes, and the only one
 * the AWS managed `ReadOnlyAccess` policy does not grant — `docs/iam-policy.md`
 * says so, and this is the feature that needs the extra statement.
 *
 * Two behaviours of the API shape the code. It delivers a `sessionStart` frame
 * before any events, which is an acknowledgement rather than data and must not
 * be shown as an empty batch. And it enforces a 3-hour session limit and a
 * throughput ceiling, signalling the latter with `sessionStreamingException`;
 * both end the stream, and the caller is told which happened rather than the
 * tail simply stopping.
 */

/** ARNs are required: unlike FilterLogEvents, names are not accepted. */
export function logGroupArn(name: string, region: string, accountId: string): string {
  if (name.startsWith('arn:')) return name
  return `arn:aws:logs:${region}:${accountId}:log-group:${name}`
}

export class LiveTailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveTailError'
  }
}

export interface LiveTailOptions extends TailOptions {
  aws: AwsClient
  accountId: string
}

/**
 * Yields batches of events as CloudWatch delivers them.
 *
 * Batches rather than single events because the API itself batches, and because
 * a busy log group would otherwise produce one SSE frame per line.
 */
export async function* tailLogs(options: LiveTailOptions): AsyncIterable<LogEvent[]> {
  const { aws, region, logGroups, filterPattern, signal, accountId } = options

  const output: StartLiveTailCommandOutput = await aws.send(
    'logs',
    region,
    'StartLiveTail',
    new StartLiveTailCommand({
      logGroupIdentifiers: logGroups.map((name) => logGroupArn(name, region, accountId)),
      // Live tail takes a plain substring, not the filter-pattern grammar
      // FilterLogEvents uses — quoting it here would search for the quotes.
      ...(filterPattern ? { logEventFilterPattern: filterPattern } : {}),
    }),
  )

  const stream = output.responseStream
  if (!stream) throw new LiveTailError('CloudWatch returned no live tail stream.')

  try {
    for await (const frame of stream as AsyncIterable<StartLiveTailResponseStream>) {
      if (signal.aborted) return

      // The handshake frame carries no events; emitting it would flash an empty
      // batch into the drawer before anything has happened.
      if (frame.sessionStart) continue

      // The SDK spells the two exception members in PascalCase while the rest
      // of the union is camelCase; matching the wrong case compiles fine under
      // a looser type and silently never fires.
      if (frame.SessionStreamingException) {
        throw new LiveTailError(
          frame.SessionStreamingException.message ??
            'CloudWatch ended the live tail session — usually the throughput ceiling.',
        )
      }
      if (frame.SessionTimeoutException) {
        throw new LiveTailError(
          'The live tail session reached its 3-hour limit. Start it again to continue.',
        )
      }

      const results = frame.sessionUpdate?.sessionResults ?? []
      if (results.length === 0) continue

      const batch: LogEvent[] = []
      for (const [index, event] of results.entries()) {
        const timestamp = event.timestamp
        const message = event.message
        if (timestamp === undefined || message === undefined) continue
        batch.push({
          id: `${event.logStreamName ?? ''}:${timestamp}:${index}`,
          timestamp,
          message,
          logGroup: event.logGroupIdentifier ?? '',
          logStream: event.logStreamName ?? '',
          severity: detectSeverity(message),
        })
      }
      if (batch.length > 0) yield batch
    }
  } finally {
    // Destroying the underlying stream is what actually ends the session; just
    // dropping the iterator leaves it open until the 3-hour limit.
    const destroyable = stream as { destroy?: () => void }
    destroyable.destroy?.()
  }
}
