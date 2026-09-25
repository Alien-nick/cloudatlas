import {
  DescribeLogGroupsCommand,
  type DescribeLogGroupsCommandOutput,
  type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs'
import type { GraphNode, LogGroupRef } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Which log groups a resource writes to, and whether they actually exist.
 *
 * The distinction is the point. A node's `logGroups` are *expected* names, put
 * there by the collectors from configuration — an RDS instance with
 * `EnabledCloudwatchLogsExports: ["postgresql"]` will write to
 * `/aws/rds/instance/<id>/postgresql`, and a Lambda function writes to
 * `/aws/lambda/<name>`. Whether that group has ever been created is a separate
 * fact, and the difference between "there are no logs" and "logging was never
 * switched on" is usually the answer someone is looking for.
 *
 * So a group that does not exist is still listed, with `exists: false` and a
 * hint saying what to turn on. An empty picker would say nothing.
 */

/** Maps a group name to the vocabulary INSIGHTS_TEMPLATES matches on. */
export function classifyLogGroup(name: string, node: GraphNode): string {
  if (name.startsWith('/aws/rds/')) return 'rds'
  if (name.startsWith('/aws/lambda/')) return 'lambda'
  if (name.startsWith('aws-waf-logs-')) return 'waf'
  if (name.startsWith('/aws/vpc/') || name.includes('flow-log')) return 'vpc'
  if (name.startsWith('/aws/network-firewall/')) return 'network-firewall'
  if (name.startsWith('/aws/apigateway/')) return 'apigateway'
  if (name.startsWith('/aws/ecs/') || node.type === 'ecs-task' || node.type === 'ecs-service') {
    return 'ecs'
  }
  if (node.type === 'ec2') return 'ec2'
  return 'generic'
}

/** Human label for the group's origin, shown next to the name. */
export function describeLogGroupKind(kind: string): string {
  switch (kind) {
    case 'rds':
      return 'RDS log export'
    case 'lambda':
      return 'Lambda'
    case 'ecs':
      return 'ECS awslogs'
    case 'waf':
      return 'WAF'
    case 'vpc':
      return 'VPC flow logs'
    case 'network-firewall':
      return 'Network Firewall'
    case 'ec2':
      return 'CloudWatch agent'
    default:
      return 'CloudWatch Logs'
  }
}

/** What to switch on when an expected group is not there. */
export function missingGroupHint(kind: string, node: GraphNode): string {
  switch (kind) {
    case 'rds':
      return `Enable log exports on ${node.name} (Modify → Log exports) for this group to be created.`
    case 'lambda':
      return 'The function has not been invoked yet, or its execution role cannot create the group.'
    case 'ecs':
      return 'The task definition names this group, but awslogs has not created it — check the execution role.'
    case 'ec2':
      return 'Install and configure the CloudWatch agent on this instance to ship logs.'
    case 'vpc':
      return 'Flow logs are not enabled for this VPC, or they are delivered to S3 rather than CloudWatch.'
    default:
      return 'This group is referenced by the resource configuration but does not exist yet.'
  }
}

/**
 * Groups a node is expected to write to, beyond the ones collectors recorded.
 *
 * Kept separate from the collectors because these are inferred from naming
 * convention rather than read from configuration — a Lambda function does not
 * report its log group unless `LoggingConfig` is set, but the default name is
 * predictable. An inferred name that turns out not to exist is reported as
 * missing, which is honest; silently omitting it would hide a function whose
 * role cannot create its own log group.
 */
export function expectedLogGroups(node: GraphNode): string[] {
  const names = [...node.logGroups]
  if (node.type === 'lambda' && names.length === 0) {
    names.push(`/aws/lambda/${node.name}`)
  }
  return [...new Set(names)]
}

/**
 * Non-CloudWatch destinations worth naming so the picker is not silently empty.
 *
 * An ALB's access logs go to S3. Someone looking for them in a log drawer that
 * shows nothing will conclude logging is off; it usually is not.
 */
export function offCloudWatchDestinations(node: GraphNode, region: string): LogGroupRef[] {
  if (node.type !== 'alb' && node.type !== 'nlb') return []
  return [
    {
      name: `${node.name} access logs`,
      kind: 'alb-access-logs',
      region,
      exists: false,
      hint: 'Load balancer access logs are delivered to S3, not CloudWatch Logs. Query them with Athena.',
      storedBytes: null,
    },
  ]
}

/**
 * Look up one group by exact name.
 *
 * `DescribeLogGroups` only filters by prefix, so `/aws/lambda/foo` also matches
 * `/aws/lambda/foobar`. Returning the first result would report a neighbouring
 * group's size as this one's, so the match is re-checked exactly.
 */
export async function findLogGroup(
  aws: AwsClient,
  region: string,
  name: string,
): Promise<LogGroup | null> {
  const groups = await aws.collect({
    service: 'logs',
    region,
    operation: 'DescribeLogGroups',
    command: (token) =>
      new DescribeLogGroupsCommand({ logGroupNamePrefix: name, nextToken: token, limit: 50 }),
    items: (out: DescribeLogGroupsCommandOutput) => out.logGroups,
    nextToken: (out: DescribeLogGroupsCommandOutput) => out.nextToken,
  })
  return groups.find((group) => group.logGroupName === name) ?? null
}

export interface DiscoverOptions {
  aws: AwsClient
  node: GraphNode
  /** Records a permission the lookup turned out not to have. */
  onWarning?: (action: string) => void
}

export async function discoverLogGroups(options: DiscoverOptions): Promise<LogGroupRef[]> {
  const { aws, node } = options
  // Global resources have no regional Logs endpoint of their own; their groups
  // live in us-east-1, which is where CloudFront and WAF deliver them.
  const region = node.region === 'global' ? 'us-east-1' : node.region

  const refs: LogGroupRef[] = []
  for (const name of expectedLogGroups(node)) {
    const kind = classifyLogGroup(name, node)
    let found: LogGroup | null = null
    try {
      found = await findLogGroup(aws, region, name)
    } catch (error) {
      const err = error as Error & { action?: string }
      if (err.name === 'AccessDeniedException') {
        options.onWarning?.(err.action ?? 'logs:DescribeLogGroups')
        // Without the permission we cannot say whether it exists. Listing it as
        // missing would be a guess, so it is listed as present and the query
        // will report the denial itself.
        refs.push({
          name,
          kind,
          region,
          exists: true,
          hint: 'Could not confirm this group exists — logs:DescribeLogGroups was denied.',
          storedBytes: null,
        })
        continue
      }
      throw error
    }

    refs.push({
      name,
      kind,
      region,
      exists: found !== null,
      hint: found ? null : missingGroupHint(kind, node),
      storedBytes: found?.storedBytes ?? null,
    })
  }

  refs.push(...offCloudWatchDestinations(node, region))
  return refs
}
