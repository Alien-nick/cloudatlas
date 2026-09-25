import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  type DBCluster,
  type DBInstance,
  type DescribeDBClustersMessage,
  type DBClusterMessage,
  type DBInstanceMessage,
} from '@aws-sdk/client-rds'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

export async function collectRds(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context
  const rds = { service: 'rds' as const, region }

  data.dbInstances = await tolerate(context, 'database', [], () =>
    aws.collect({
      ...rds,
      operation: 'DescribeDBInstances',
      command: (token) => new DescribeDBInstancesCommand({ Marker: token }),
      items: (out: DBInstanceMessage) => out.DBInstances,
      nextToken: (out: DBInstanceMessage) => out.Marker,
    }),
  )

  data.dbClusters = await tolerate(context, 'database', [], () =>
    aws.collect({
      ...rds,
      operation: 'DescribeDBClusters',
      command: (token) =>
        new DescribeDBClustersCommand({ Marker: token } satisfies DescribeDBClustersMessage),
      items: (out: DBClusterMessage) => out.DBClusters,
      nextToken: (out: DBClusterMessage) => out.Marker,
    }),
  )

  context.onStep?.('rds')
}

/** RDS returns tags inline on describe since 2023; older shapes may not. */
export function rdsTags(resource: DBInstance | DBCluster): Array<{ key: string; value: string }> {
  return (resource.TagList ?? [])
    .filter((tag) => typeof tag.Key === 'string')
    .map((tag) => ({ key: tag.Key as string, value: tag.Value ?? '' }))
}
