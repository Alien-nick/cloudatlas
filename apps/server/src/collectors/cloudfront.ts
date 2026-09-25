import {
  ListDistributionsCommand,
  type ListDistributionsCommandOutput,
} from '@aws-sdk/client-cloudfront'
import { GLOBAL_REGION } from '../aws/client.js'
import type { CollectorContext, GlobalScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * CloudFront distributions.
 *
 * `ListDistributions` returns a `DistributionSummary` that already carries the
 * origins, aliases and default behaviour, so `GetDistribution` is not called
 * per distribution. The registry keeps the entry planned rather than active
 * for that reason: it is only needed once the detail panel wants cache
 * behaviours, which nothing asks for yet.
 */
export async function collectCloudFront(
  context: CollectorContext,
  data: GlobalScanData,
): Promise<void> {
  const { aws } = context

  data.distributions = await tolerate(context, 'network', [], () =>
    aws.collect({
      service: 'cloudfront',
      region: GLOBAL_REGION,
      operation: 'ListDistributions',
      command: (token) => new ListDistributionsCommand({ Marker: token }),
      items: (out: ListDistributionsCommandOutput) => out.DistributionList?.Items,
      nextToken: (out: ListDistributionsCommandOutput) =>
        out.DistributionList?.IsTruncated ? out.DistributionList.NextMarker : undefined,
    }),
  )

  context.onStep?.('cloudfront')
}
