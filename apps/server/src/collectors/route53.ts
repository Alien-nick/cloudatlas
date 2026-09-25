import {
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  type ListHostedZonesCommandOutput,
  type ListResourceRecordSetsCommandOutput,
} from '@aws-sdk/client-route-53'
import { GLOBAL_REGION } from '../aws/client.js'
import type { CollectorContext, GlobalScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * Route 53 hosted zones and the records that point into the account.
 *
 * Only alias and CNAME records are kept. A zone can hold thousands of records,
 * and the graph only cares about the ones that terminate at something else on
 * the diagram — an alias to a load balancer or a distribution is an edge, a TXT
 * record for domain verification is not.
 */

/** Record types that can point at another node in the graph. */
const LINKING_TYPES = new Set(['A', 'AAAA', 'CNAME'])

export function isLinkingRecord(record: {
  Type?: string
  AliasTarget?: { DNSName?: string }
}): boolean {
  if (record.AliasTarget?.DNSName) return true
  return record.Type !== undefined && LINKING_TYPES.has(record.Type)
}

export async function collectRoute53(
  context: CollectorContext,
  data: GlobalScanData,
): Promise<void> {
  const { aws } = context

  data.hostedZones = await tolerate(context, 'network', [], () =>
    aws.collect({
      service: 'route53',
      region: GLOBAL_REGION,
      operation: 'ListHostedZones',
      command: (token) => new ListHostedZonesCommand({ Marker: token }),
      items: (out: ListHostedZonesCommandOutput) => out.HostedZones,
      nextToken: (out: ListHostedZonesCommandOutput) =>
        out.IsTruncated ? out.NextMarker : undefined,
    }),
  )

  for (const zone of data.hostedZones) {
    const id = zone.Id
    if (!id) continue

    const records = await tolerate(context, 'network', [], () =>
      aws.collect({
        service: 'route53',
        region: GLOBAL_REGION,
        operation: 'ListResourceRecordSets',
        // Route 53 paginates by name+type rather than an opaque token, so the
        // generic token helper only drives the first page here.
        command: () => new ListResourceRecordSetsCommand({ HostedZoneId: id, MaxItems: 300 }),
        items: (out: ListResourceRecordSetsCommandOutput) => out.ResourceRecordSets,
        nextToken: () => undefined,
      }),
    )
    data.recordSets[id] = records.filter(isLinkingRecord)
  }

  context.onStep?.('route53')
}
