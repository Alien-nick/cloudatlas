import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  type DescribeListenersOutput,
  type DescribeLoadBalancersOutput,
  type DescribeTagsOutput,
  type DescribeTargetGroupsOutput,
  type DescribeTargetHealthOutput,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/** DescribeTags accepts at most 20 ARNs per call. */
const TAG_BATCH = 20

export async function collectElbv2(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context
  const elb = { service: 'elasticloadbalancing' as const, region }

  data.loadBalancers = await tolerate(context, 'network', [], () =>
    aws.collect({
      ...elb,
      operation: 'DescribeLoadBalancers',
      command: (token) => new DescribeLoadBalancersCommand({ Marker: token }),
      items: (out: DescribeLoadBalancersOutput) => out.LoadBalancers,
      nextToken: (out: DescribeLoadBalancersOutput) => out.NextMarker,
    }),
  )

  data.targetGroups = await tolerate(context, 'network', [], () =>
    aws.collect({
      ...elb,
      operation: 'DescribeTargetGroups',
      command: (token) => new DescribeTargetGroupsCommand({ Marker: token }),
      items: (out: DescribeTargetGroupsOutput) => out.TargetGroups,
      nextToken: (out: DescribeTargetGroupsOutput) => out.NextMarker,
    }),
  )

  // Listeners and target health are both per-load-balancer / per-target-group,
  // so they are the calls that scale with estate size. The client's per-region
  // concurrency limit keeps them from stampeding the API.
  for (const lb of data.loadBalancers) {
    if (!lb.LoadBalancerArn) continue
    const listeners = await tolerate(context, 'network', [], () =>
      aws.collect({
        ...elb,
        operation: 'DescribeListeners',
        command: (token) =>
          new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn, Marker: token }),
        items: (out: DescribeListenersOutput) => out.Listeners,
        nextToken: (out: DescribeListenersOutput) => out.NextMarker,
      }),
    )
    data.listeners.push(...listeners)
  }

  for (const tg of data.targetGroups) {
    if (!tg.TargetGroupArn) continue
    const health = await tolerate(context, 'network', undefined, () =>
      aws.send<DescribeTargetHealthOutput>(
        'elasticloadbalancing',
        region,
        'DescribeTargetHealth',
        new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
      ),
    )
    if (health?.TargetHealthDescriptions) {
      data.targetHealth[tg.TargetGroupArn] = health.TargetHealthDescriptions
    }
  }

  const arns = data.loadBalancers
    .map((lb) => lb.LoadBalancerArn)
    .filter((arn): arn is string => typeof arn === 'string')

  for (let i = 0; i < arns.length; i += TAG_BATCH) {
    const batch = arns.slice(i, i + TAG_BATCH)
    const tags = await tolerate(context, 'network', undefined, () =>
      aws.send<DescribeTagsOutput>(
        'elasticloadbalancing',
        region,
        'DescribeTags',
        new DescribeTagsCommand({ ResourceArns: batch }),
      ),
    )
    for (const description of tags?.TagDescriptions ?? []) {
      if (description.ResourceArn) data.loadBalancerTags[description.ResourceArn] = description
    }
  }

  context.onStep?.('elbv2')
}
