import {
  DescribeAlarmHistoryCommand,
  type AlarmHistoryItem as AwsAlarmHistoryItem,
  type DescribeAlarmHistoryOutput,
} from '@aws-sdk/client-cloudwatch'
import type { AlarmHistoryItem } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Alarm state history.
 *
 * The useful part is not the summary line AWS writes — "Alarm updated from OK
 * to ALARM" tells you nothing you did not already know from the alarm's current
 * state. It is `stateReason` inside `HistoryData`, which names the datapoints
 * that crossed the threshold and the threshold they crossed. That is the
 * difference between "CPU alarmed" and "one 5-minute datapoint at 93.4% was
 * above the 80% threshold at 01:15".
 *
 * Configuration changes are kept rather than filtered out. An alarm whose
 * threshold was edited twenty minutes before it fired is a materially different
 * story from one that fired on its own, and dropping those rows hides it.
 */

/** Newest first, and enough to cover an incident without paging forever. */
const MAX_ITEMS = 60

interface HistoryData {
  newState?: { stateValue?: string; stateReason?: string }
  oldState?: { stateValue?: string }
}

function parseHistoryData(raw: string | undefined): HistoryData | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HistoryData) : null
  } catch {
    // Malformed history data must not cost the whole timeline.
    return null
  }
}

export function toHistoryItem(item: AwsAlarmHistoryItem): AlarmHistoryItem | null {
  const timestamp = item.Timestamp?.getTime()
  if (timestamp === undefined) return null

  const data = parseHistoryData(item.HistoryData)
  const state = data?.newState?.stateValue ?? null
  const reason = data?.newState?.stateReason?.trim()
  const summary = item.HistorySummary ?? item.HistoryItemType ?? 'Alarm history entry'

  return {
    timestamp,
    // The reason is appended rather than substituted: the summary says what
    // changed, the reason says why, and an incident review wants both.
    summary: reason ? `${summary}. ${reason}` : summary,
    // Null for a configuration update, which has no new alarm state.
    state,
  }
}

export interface AlarmHistoryOptions {
  aws: AwsClient
  region: string
  alarmName: string
  /** How far back to look. Defaults to 24 hours. */
  since?: number
  now?: number
}

export async function fetchAlarmHistory(
  options: AlarmHistoryOptions,
): Promise<AlarmHistoryItem[]> {
  const { aws, region, alarmName } = options
  const now = options.now ?? Date.now()
  const start = options.since ?? now - 24 * 60 * 60 * 1000

  const items = await aws.collect({
    service: 'cloudwatch',
    region,
    operation: 'DescribeAlarmHistory',
    command: (token) =>
      new DescribeAlarmHistoryCommand({
        AlarmName: alarmName,
        StartDate: new Date(start),
        EndDate: new Date(now),
        // ScanBy is newest-first so the first page covers the recent incident
        // even when an alarm has flapped hundreds of times.
        ScanBy: 'TimestampDescending',
        MaxRecords: 100,
        NextToken: token,
      }),
    items: (out: DescribeAlarmHistoryOutput) => out.AlarmHistoryItems,
    nextToken: (out: DescribeAlarmHistoryOutput) => out.NextToken,
  })

  const mapped = items
    .map(toHistoryItem)
    .filter((item): item is AlarmHistoryItem => item !== null)
    .sort((a, b) => b.timestamp - a.timestamp)

  return mapped.slice(0, MAX_ITEMS)
}
