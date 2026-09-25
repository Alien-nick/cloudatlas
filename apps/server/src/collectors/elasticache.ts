import {
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  ListTagsForResourceCommand,
  type CacheClusterMessage,
  type ReplicationGroupMessage,
  type TagListMessage,
} from '@aws-sdk/client-elasticache'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

export async function collectElastiCache(
  context: CollectorContext,
  data: RegionScanData,
): Promise<void> {
  const { aws, region } = context
  const cache = { service: 'elasticache' as const, region }

  // ShowCacheNodeInfo gives per-node endpoints, which is what places a node in
  // the right AZ and subnet.
  data.cacheClusters = await tolerate(context, 'database', [], () =>
    aws.collect({
      ...cache,
      operation: 'DescribeCacheClusters',
      command: (token) =>
        new DescribeCacheClustersCommand({ Marker: token, ShowCacheNodeInfo: true }),
      items: (out: CacheClusterMessage) => out.CacheClusters,
      nextToken: (out: CacheClusterMessage) => out.Marker,
    }),
  )

  data.replicationGroups = await tolerate(context, 'database', [], () =>
    aws.collect({
      ...cache,
      operation: 'DescribeReplicationGroups',
      command: (token) => new DescribeReplicationGroupsCommand({ Marker: token }),
      items: (out: ReplicationGroupMessage) => out.ReplicationGroups,
      nextToken: (out: ReplicationGroupMessage) => out.Marker,
    }),
  )

  // ElastiCache returns no tags inline and has no batch tag API, so this is one
  // call per cluster. It is the only per-resource tag call in the M2 scope.
  for (const cluster of data.cacheClusters) {
    const arn = cluster.ARN
    if (!arn) continue
    const tags = await tolerate(context, 'database', undefined, () =>
      aws.send<TagListMessage>(
        'elasticache',
        region,
        'ListTagsForResource',
        new ListTagsForResourceCommand({ ResourceName: arn }),
      ),
    )
    if (tags?.TagList) data.cacheClusterTags[arn] = tags.TagList
  }

  context.onStep?.('elasticache')
}
