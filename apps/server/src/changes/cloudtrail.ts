import {
  LookupEventsCommand,
  type Event as CloudTrailEvent,
  type LookupEventsCommandOutput,
} from '@aws-sdk/client-cloudtrail'
import type { GraphNode, RecentChange } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * "What changed recently", from CloudTrail.
 *
 * `LookupEvents` is deliberately narrow here. CloudTrail records every API call
 * in the account, the overwhelming majority of which are reads made by AWS's
 * own services, and returning those would bury the one deploy that actually
 * explains an incident. So the lookup asks only for write events.
 *
 * Three limits worth knowing, because each one silently shrinks the answer:
 *  - lookup only covers the last 90 days;
 *  - it is throttled hard, so this pages conservatively rather than fanning out;
 *  - `ReadOnly` is an attribute on the event, and filtering on it server-side
 *    is what keeps the result small enough to be useful.
 */

/** CloudTrail retains lookup history for 90 days. */
export const LOOKUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Pages to walk per region before giving up; each page is up to 50 events. */
const MAX_PAGES = 10

/** Resource identifiers CloudTrail attached to the event. */
export function resourcesOf(event: CloudTrailEvent): string[] {
  const out: string[] = []
  for (const resource of event.Resources ?? []) {
    if (resource.ResourceName) out.push(resource.ResourceName)
  }
  return [...new Set(out)]
}

/**
 * Match an event to a node.
 *
 * Exact identifier matching only. A near-match would attribute someone else's
 * change to the resource you are looking at, which is worse than showing the
 * event unattached — the timeline exists to explain an incident, and a wrong
 * attribution sends the reader after the wrong deploy.
 */
export function resolveNodeId(resources: string[], nodes: GraphNode[]): string | null {
  const byId = new Map<string, string>()
  for (const node of nodes) {
    byId.set(node.id, node.id)
    if (node.arn) byId.set(node.arn, node.id)
    // The bare name is only distinctive enough where the name *is* the
    // identifier — an RDS instance id, a bucket, a queue, a function.
    if (node.type === 'rds' || node.type === 's3' || node.type === 'sqs' || node.type === 'lambda') {
      byId.set(node.name, node.id)
    }
  }
  for (const resource of resources) {
    const match = byId.get(resource)
    if (match) return match
  }
  return null
}

export function toRecentChange(
  event: CloudTrailEvent,
  region: string,
  nodes: GraphNode[],
): RecentChange | null {
  const timestamp = event.EventTime?.getTime()
  if (timestamp === undefined || !event.EventName) return null
  const resources = resourcesOf(event)

  return {
    timestamp,
    eventName: event.EventName,
    eventSource: event.EventSource ?? 'unknown',
    username: event.Username ?? null,
    resources,
    region,
    nodeId: resolveNodeId(resources, nodes),
  }
}

export interface ChangesOptions {
  aws: AwsClient
  regions: string[]
  nodes: GraphNode[]
  start: number
  end: number
  now?: number
  /** Records a permission the lookup turned out not to have. */
  onWarning?: (action: string) => void
}

export async function lookupChanges(options: ChangesOptions): Promise<RecentChange[]> {
  const { aws, regions, nodes, end } = options
  const now = options.now ?? Date.now()
  // Asking past retention returns nothing rather than an error, which reads as
  // "nothing changed" instead of "we cannot see that far back".
  const start = Math.max(options.start, now - LOOKUP_RETENTION_MS)

  const changes: RecentChange[] = []
  for (const region of regions) {
    try {
      let token: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const output: LookupEventsCommandOutput = await aws.send(
          'cloudtrail',
          region,
          'LookupEvents',
          new LookupEventsCommand({
            StartTime: new Date(start),
            EndTime: new Date(end),
            // Reads are the overwhelming majority and none of them changed
            // anything — filtering server-side is what keeps this usable.
            LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }],
            MaxResults: 50,
            NextToken: token,
          }),
        )

        for (const event of output.Events ?? []) {
          const change = toRecentChange(event, region, nodes)
          if (change) changes.push(change)
        }
        token = output.NextToken
        if (!token) break
      }
    } catch (error) {
      const err = error as Error & { action?: string }
      if (err.name === 'AccessDeniedException') {
        // One region's trail being unreadable must not lose the others.
        options.onWarning?.(err.action ?? 'cloudtrail:LookupEvents')
        continue
      }
      throw error
    }
  }

  // Newest first: a change timeline is read backwards from the incident.
  return changes.sort((a, b) => b.timestamp - a.timestamp)
}
