import {
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  type DescribeInternetGatewaysResult,
  type DescribeNatGatewaysResult,
  type DescribeNetworkInterfacesResult,
  type DescribeRouteTablesResult,
  type DescribeSecurityGroupsResult,
  type DescribeSubnetsResult,
  type DescribeVpcsResult,
  DescribeFlowLogsCommand,
  type DescribeFlowLogsResult,
} from '@aws-sdk/client-ec2'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * VPC-level topology: the containers, the wiring that classifies a subnet as
 * public or private, and the security groups the risk analysis runs on.
 */
export async function collectVpc(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context
  const ec2 = { service: 'ec2' as const, region }

  data.vpcs = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeVpcs',
      command: (token) => new DescribeVpcsCommand({ NextToken: token }),
      items: (out: DescribeVpcsResult) => out.Vpcs,
      nextToken: (out: DescribeVpcsResult) => out.NextToken,
    }),
  )

  data.subnets = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeSubnets',
      command: (token) => new DescribeSubnetsCommand({ NextToken: token }),
      items: (out: DescribeSubnetsResult) => out.Subnets,
      nextToken: (out: DescribeSubnetsResult) => out.NextToken,
    }),
  )

  // Route tables are what decide whether a subnet renders green (public) or
  // blue (private): a 0.0.0.0/0 route to an igw- target means public.
  data.routeTables = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeRouteTables',
      command: (token) => new DescribeRouteTablesCommand({ NextToken: token }),
      items: (out: DescribeRouteTablesResult) => out.RouteTables,
      nextToken: (out: DescribeRouteTablesResult) => out.NextToken,
    }),
  )

  data.internetGateways = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeInternetGateways',
      command: (token) => new DescribeInternetGatewaysCommand({ NextToken: token }),
      items: (out: DescribeInternetGatewaysResult) => out.InternetGateways,
      nextToken: (out: DescribeInternetGatewaysResult) => out.NextToken,
    }),
  )

  data.natGateways = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeNatGateways',
      command: (token) => new DescribeNatGatewaysCommand({ NextToken: token }),
      items: (out: DescribeNatGatewaysResult) => out.NatGateways,
      nextToken: (out: DescribeNatGatewaysResult) => out.NextToken,
    }),
  )

  // ENIs are how an ECS task's private IP is traced back to a load balancer
  // target, so this matters more than its size suggests.
  data.networkInterfaces = await tolerate(context, 'vpc', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeNetworkInterfaces',
      command: (token) => new DescribeNetworkInterfacesCommand({ NextToken: token }),
      items: (out: DescribeNetworkInterfacesResult) => out.NetworkInterfaces,
      nextToken: (out: DescribeNetworkInterfacesResult) => out.NextToken,
    }),
  )

  data.securityGroups = await tolerate(context, 'security', [], () =>
    aws.collect({
      ...ec2,
      operation: 'DescribeSecurityGroups',
      command: (token) => new DescribeSecurityGroupsCommand({ NextToken: token }),
      items: (out: DescribeSecurityGroupsResult) => out.SecurityGroups,
      nextToken: (out: DescribeSecurityGroupsResult) => out.NextToken,
    }),
  )

  // Flow logs say where a VPC's traffic records are delivered. Without this a
  // VPC's Logs tab is empty, which reads as "flow logs are off" when they are
  // often on and going to S3.
  data.flowLogs = await tolerate(context, 'network', [], () =>
    aws.collect({
      service: 'ec2',
      region,
      operation: 'DescribeFlowLogs',
      command: (token) => new DescribeFlowLogsCommand({ NextToken: token }),
      items: (out: DescribeFlowLogsResult) => out.FlowLogs,
      nextToken: (out: DescribeFlowLogsResult) => out.NextToken,
    }),
  )

  context.onStep?.('vpc')
}
