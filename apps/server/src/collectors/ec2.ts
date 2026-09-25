import {
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  type DescribeInstanceStatusResult,
  type DescribeInstancesResult,
  type DescribeVolumesResult,
  type Instance,
} from '@aws-sdk/client-ec2'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

export async function collectEc2(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context
  const ec2 = { service: 'ec2' as const, region }

  const reservations = await tolerate(context, 'compute', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeInstances',
      command: (token) => new DescribeInstancesCommand({ NextToken: token }),
      items: (out: DescribeInstancesResult) => out.Reservations,
      nextToken: (out: DescribeInstancesResult) => out.NextToken,
    }),
  )
  data.instances = reservations.flatMap((r) => r.Instances ?? []).filter(isRealInstance)

  // IncludeAllInstances so stopped instances appear rather than silently
  // vanishing from the status map.
  data.instanceStatuses = await tolerate(context, 'compute', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeInstanceStatus',
      command: (token) =>
        new DescribeInstanceStatusCommand({ NextToken: token, IncludeAllInstances: true }),
      items: (out: DescribeInstanceStatusResult) => out.InstanceStatuses,
      nextToken: (out: DescribeInstanceStatusResult) => out.NextToken,
    }),
  )

  data.volumes = await tolerate(context, 'compute', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeVolumes',
      command: (token) => new DescribeVolumesCommand({ NextToken: token }),
      items: (out: DescribeVolumesResult) => out.Volumes,
      nextToken: (out: DescribeVolumesResult) => out.NextToken,
    }),
  )

  context.onStep?.('ec2')
}

/** Terminated instances linger in the API for an hour; they are not topology. */
function isRealInstance(instance: Instance): boolean {
  const state = instance.State?.Name
  return state !== 'terminated' && state !== 'shutting-down'
}
