import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  type DescribeClustersResponse,
  type DescribeServicesResponse,
  type DescribeTaskDefinitionResponse,
  type DescribeTasksResponse,
  type ListClustersResponse,
  type ListServicesResponse,
  type ListTasksResponse,
} from '@aws-sdk/client-ecs'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/** ECS Describe* calls accept at most 10 identifiers per request. */
const DESCRIBE_BATCH = 10

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function collectEcs(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context
  const ecs = { service: 'ecs' as const, region }

  const clusterArns = await tolerate(context, 'compute', [], () =>
    aws.collect({
      ...ecs,
      operation: 'ListClusters',
      command: (token) => new ListClustersCommand({ nextToken: token }),
      items: (out: ListClustersResponse) => out.clusterArns,
      nextToken: (out: ListClustersResponse) => out.nextToken,
    }),
  )
  if (clusterArns.length === 0) {
    context.onStep?.('ecs')
    return
  }

  for (const batch of chunk(clusterArns, DESCRIBE_BATCH)) {
    const described = await tolerate(context, 'compute', undefined, () =>
      aws.send<DescribeClustersResponse>(
        'ecs',
        region,
        'DescribeClusters',
        new DescribeClustersCommand({ clusters: batch, include: ['TAGS'] }),
      ),
    )
    data.ecsClusters.push(...(described?.clusters ?? []))
  }

  for (const clusterArn of clusterArns) {
    const serviceArns = await tolerate(context, 'compute', [], () =>
      aws.collect({
        ...ecs,
        operation: 'ListServices',
        command: (token) => new ListServicesCommand({ cluster: clusterArn, nextToken: token }),
        items: (out: ListServicesResponse) => out.serviceArns,
        nextToken: (out: ListServicesResponse) => out.nextToken,
      }),
    )
    for (const batch of chunk(serviceArns, DESCRIBE_BATCH)) {
      const described = await tolerate(context, 'compute', undefined, () =>
        aws.send<DescribeServicesResponse>(
          'ecs',
          region,
          'DescribeServices',
          new DescribeServicesCommand({ cluster: clusterArn, services: batch, include: ['TAGS'] }),
        ),
      )
      data.ecsServices.push(...(described?.services ?? []))
    }

    const taskArns = await tolerate(context, 'compute', [], () =>
      aws.collect({
        ...ecs,
        operation: 'ListTasks',
        command: (token) => new ListTasksCommand({ cluster: clusterArn, nextToken: token }),
        items: (out: ListTasksResponse) => out.taskArns,
        nextToken: (out: ListTasksResponse) => out.nextToken,
      }),
    )
    for (const batch of chunk(taskArns, DESCRIBE_BATCH)) {
      const described = await tolerate(context, 'compute', undefined, () =>
        aws.send<DescribeTasksResponse>(
          'ecs',
          region,
          'DescribeTasks',
          new DescribeTasksCommand({ cluster: clusterArn, tasks: batch, include: ['TAGS'] }),
        ),
      )
      data.ecsTasks.push(...(described?.tasks ?? []))
    }
  }

  // One describe per distinct task definition, not per task — a service with
  // 50 tasks shares one revision.
  const definitionArns = [
    ...new Set(
      data.ecsTasks
        .map((task) => task.taskDefinitionArn)
        .filter((arn): arn is string => typeof arn === 'string'),
    ),
  ]
  for (const arn of definitionArns) {
    const described = await tolerate(context, 'compute', undefined, () =>
      aws.send<DescribeTaskDefinitionResponse>(
        'ecs',
        region,
        'DescribeTaskDefinition',
        new DescribeTaskDefinitionCommand({ taskDefinition: arn }),
      ),
    )
    if (described?.taskDefinition) data.taskDefinitions[arn] = described.taskDefinition
  }

  context.onStep?.('ecs')
}
