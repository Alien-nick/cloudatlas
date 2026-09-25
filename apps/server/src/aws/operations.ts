/**
 * Every AWS API CloudAtlas is allowed to call, in one place.
 *
 * This registry is the single source of truth for three things:
 *
 *  1. `aws/client.ts` refuses to execute an operation that is not listed here
 *     and marked `active`, so the read-only guarantee cannot drift.
 *  2. `scripts/generate-iam-policy.ts` emits `docs/iam-policy.json` from it, so
 *     the policy is derived from real call sites rather than written from memory.
 *  3. The capture tool reports call counts per action.
 *
 * Adding a collector means adding its operations here first. That is deliberate:
 * it forces the permission surface to be an explicit decision.
 */

export type OperationStatus = 'active' | 'planned'

export interface AwsOperationSpec {
  /** IAM service prefix, e.g. "ec2". */
  service: string
  /** SDK command name without the `Command` suffix, e.g. "DescribeInstances". */
  operation: string
  /**
   * IAM action name, when it differs from the SDK command name. S3 is the main
   * offender: `GetBucketEncryption` is authorised by `s3:GetEncryptionConfiguration`.
   */
  iamAction?: string
  /** Why CloudAtlas calls it. Rendered into the generated policy doc. */
  purpose: string
  /** `active` operations are wired to a collector today. */
  status: OperationStatus
  /** Milestone that introduced (or will introduce) the call. */
  milestone: string
  /** Only called when a config flag is on; kept out of the base policy. */
  optional?: boolean
  /**
   * Set when the permission is required by a *parameter* on another call rather
   * than by a call of its own — `ecs:ListTagsForResource` is needed for
   * `include: ["TAGS"]`, for instance. These have no call site to find, so the
   * registry check skips them and the docs explain why they are in the policy.
   */
  impliedBy?: string
  /**
   * Whether the AWS managed `ReadOnlyAccess` policy grants this. `unverified`
   * means we have not confirmed it against the live managed policy — the docs
   * tell the reader how to check rather than guessing on their behalf.
   */
  readOnlyAccess: 'covered' | 'gap' | 'unverified'
}

export const AWS_OPERATIONS: AwsOperationSpec[] = [
  // --- identity -----------------------------------------------------------
  { service: 'sts', operation: 'GetCallerIdentity', purpose: 'Resolve the account id and principal for the selected profile.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'iam', operation: 'ListAccountAliases', purpose: 'Show the account alias in the top bar instead of a bare 12-digit id.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- regions ------------------------------------------------------------
  { service: 'ec2', operation: 'DescribeRegions', purpose: 'List regions enabled for the account to populate the region picker.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- VPC topology -------------------------------------------------------
  { service: 'ec2', operation: 'DescribeVpcs', purpose: 'Top-level VPC containers and their CIDR blocks.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeSubnets', purpose: 'Subnet containers, CIDRs and AZ placement.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeRouteTables', purpose: 'Classify a subnet public or private by whether 0.0.0.0/0 routes to an internet gateway.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeInternetGateways', purpose: 'Resolve igw- targets referenced by route tables.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeNatGateways', purpose: 'NAT gateway nodes and their subnet placement.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeNetworkInterfaces', purpose: 'Map ENIs and private IPs back to ECS tasks and load balancer nodes.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeSecurityGroups', purpose: 'Security group rules, which drive SG-to-SG edges and the risky-rule findings.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- EC2 ----------------------------------------------------------------
  { service: 'ec2', operation: 'DescribeInstances', purpose: 'EC2 instance nodes, placement, IMDS settings and attached security groups.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeInstanceStatus', purpose: 'Instance and system status-check state at scan time.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ec2', operation: 'DescribeVolumes', purpose: 'EBS volumes attached to an instance, including encryption state.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- Elastic Load Balancing v2 -----------------------------------------
  { service: 'elasticloadbalancing', operation: 'DescribeLoadBalancers', purpose: 'ALB and NLB nodes, scheme and subnet placement.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticloadbalancing', operation: 'DescribeListeners', purpose: 'Listener ports and protocols for the load balancer detail panel.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticloadbalancing', operation: 'DescribeTargetGroups', purpose: 'Target groups that connect a listener to its backends.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticloadbalancing', operation: 'DescribeTargetHealth', purpose: 'Resolve target group members to instances or IPs, and their health.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticloadbalancing', operation: 'DescribeTags', purpose: 'Load balancer tags for the tag filter and environment chips.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- RDS ----------------------------------------------------------------
  { service: 'rds', operation: 'DescribeDBInstances', purpose: 'RDS instance nodes, engine, endpoint, Multi-AZ and encryption state. Tags come back inline as TagList, so no separate tag call is needed.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'rds', operation: 'DescribeDBClusters', purpose: 'Aurora cluster nodes and their member instances.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'rds', operation: 'DescribeDBParameters', purpose: 'Read max_connections so the connection-spike detector has a real denominator.', status: 'active', milestone: 'M3', readOnlyAccess: 'covered' },

  // --- ElastiCache --------------------------------------------------------
  { service: 'elasticache', operation: 'DescribeCacheClusters', purpose: 'Redis and Memcached node groups.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticache', operation: 'DescribeReplicationGroups', purpose: 'Primary and replica relationships for Redis replication groups.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'elasticache', operation: 'ListTagsForResource', purpose: 'ElastiCache tags, not returned by the describe call.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },

  // --- ECS ----------------------------------------------------------------
  { service: 'ecs', operation: 'ListClusters', purpose: 'Discover ECS clusters in the region.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'DescribeClusters', purpose: 'Cluster names and running task counts.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'ListServices', purpose: 'Services within each cluster.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'DescribeServices', purpose: 'Service desired/running counts and load balancer wiring.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'ListTasks', purpose: 'Running tasks per cluster.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'DescribeTasks', purpose: 'Task placement, ENI attachment and health.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'DescribeTaskDefinition', purpose: 'Read the awslogs group so the Logs tab knows where a task writes.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'ecs', operation: 'ListTagsForResource', purpose: 'Required for the include=TAGS parameter on DescribeClusters, DescribeServices and DescribeTasks.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered', impliedBy: 'ecs:DescribeClusters, ecs:DescribeServices, ecs:DescribeTasks (include=TAGS)' },

  // --- CloudWatch ---------------------------------------------------------
  { service: 'cloudwatch', operation: 'DescribeAlarms', purpose: 'Ingest metric and composite alarms, and map them to nodes by dimension.', status: 'active', milestone: 'M2', readOnlyAccess: 'covered' },
  { service: 'cloudwatch', operation: 'DescribeAlarmHistory', purpose: 'Timeline for a firing alarm.', status: 'active', milestone: 'M3', readOnlyAccess: 'covered' },
  { service: 'cloudwatch', operation: 'GetMetricData', purpose: 'Batched time-series for the Metrics tab and the spike detector.', status: 'active', milestone: 'M3', readOnlyAccess: 'covered' },

  // --- Performance Insights ----------------------------------------------
  { service: 'pi', operation: 'GetResourceMetrics', purpose: 'db.load.avg for RDS instances with Performance Insights enabled.', status: 'active', milestone: 'M6', readOnlyAccess: 'unverified' },
  { service: 'pi', operation: 'DescribeDimensionKeys', purpose: 'Top SQL and top wait events during a database spike.', status: 'active', milestone: 'M6', readOnlyAccess: 'unverified' },

  // --- CloudWatch Logs ----------------------------------------------------
  { service: 'logs', operation: 'DescribeLogGroups', purpose: 'Discover which log groups exist for a resource.', status: 'active', milestone: 'M4', readOnlyAccess: 'covered' },
  { service: 'logs', operation: 'FilterLogEvents', purpose: 'Log drawer search, and the polling fallback when live tail is unavailable.', status: 'active', milestone: 'M4', readOnlyAccess: 'covered' },
  { service: 'logs', operation: 'StartQuery', purpose: 'Run a Logs Insights query.', status: 'active', milestone: 'M4', readOnlyAccess: 'unverified' },
  { service: 'logs', operation: 'GetQueryResults', purpose: 'Poll a Logs Insights query to completion.', status: 'active', milestone: 'M4', readOnlyAccess: 'unverified' },
  { service: 'logs', operation: 'StopQuery', purpose: 'Cancel an Insights query when the user navigates away.', status: 'active', milestone: 'M4', readOnlyAccess: 'unverified' },
  { service: 'logs', operation: 'StartLiveTail', purpose: 'Stream new log events into the drawer.', status: 'active', milestone: 'M4', readOnlyAccess: 'gap' },

  // --- VPC flow logs ------------------------------------------------------
  { service: 'ec2', operation: 'DescribeFlowLogs', purpose: 'Find the log group VPC flow logs are delivered to.', status: 'active', milestone: 'M4', readOnlyAccess: 'covered' },

  // --- WAF ----------------------------------------------------------------
  { service: 'wafv2', operation: 'ListWebACLs', purpose: 'Web ACL nodes for both CLOUDFRONT and REGIONAL scopes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'wafv2', operation: 'GetWebACL', purpose: 'Rules, default action and rate limits for a web ACL.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'wafv2', operation: 'ListResourcesForWebACL', purpose: 'Edges from a web ACL to the ALBs it protects.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'wafv2', operation: 'GetSampledRequests', purpose: 'Sampled blocked requests grouped by rule, IP, country and URI.', status: 'active', milestone: 'M4+', readOnlyAccess: 'unverified' },
  { service: 'wafv2', operation: 'GetLoggingConfiguration', purpose: 'Determine whether WAF logs reach CloudWatch or S3/Firehose.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },

  // --- remaining collectors ----------------------------------------------
  { service: 's3', operation: 'ListBuckets', iamAction: 'ListAllMyBuckets', purpose: 'S3 bucket nodes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 's3', operation: 'GetBucketLocation', purpose: 'Place each bucket in the right region lane.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 's3', operation: 'GetBucketTagging', purpose: 'Bucket tags for the tag filter.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 's3', operation: 'GetBucketEncryption', iamAction: 'GetEncryptionConfiguration', purpose: 'Flag unencrypted buckets in the posture findings.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 's3', operation: 'GetPublicAccessBlock', iamAction: 'GetBucketPublicAccessBlock', purpose: 'Flag buckets without public access block.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 's3', operation: 'GetBucketNotificationConfiguration', iamAction: 'GetBucketNotification', purpose: 'S3 -> Lambda/SQS event edges.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'lambda', operation: 'ListFunctions', purpose: 'Lambda function nodes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'lambda', operation: 'ListEventSourceMappings', purpose: 'Event edges from SQS and streams into Lambda.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'lambda', operation: 'ListTags', purpose: 'Lambda tags.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'cloudfront', operation: 'ListDistributions', purpose: 'CloudFront distribution nodes and their origins.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'route53', operation: 'ListHostedZones', purpose: 'Hosted zone nodes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'route53', operation: 'ListResourceRecordSets', purpose: 'Alias records pointing at CloudFront and load balancers.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'sqs', operation: 'ListQueues', purpose: 'SQS queue nodes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'sqs', operation: 'GetQueueAttributes', purpose: 'Queue configuration, DLQ wiring and encryption.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'sqs', operation: 'ListQueueTags', purpose: 'Queue tags.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'iam', operation: 'ListRoles', purpose: 'IAM role nodes referenced by tasks and instances.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'network-firewall', operation: 'ListFirewalls', purpose: 'Network Firewall nodes.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'network-firewall', operation: 'DescribeFirewall', purpose: 'Firewall endpoints, policy and home net.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },
  { service: 'network-firewall', operation: 'DescribeLoggingConfiguration', purpose: 'Where firewall alert logs are delivered.', status: 'active', milestone: 'M4+', readOnlyAccess: 'covered' },

  // --- agent --------------------------------------------------------------
  { service: 'cloudtrail', operation: 'LookupEvents', purpose: 'Answer "what changed in the last hour" with write events on relevant resources.', status: 'active', milestone: 'M5', readOnlyAccess: 'covered' },

  // --- optional, behind a config flag ------------------------------------
  { service: 'ce', operation: 'GetCostAndUsage', purpose: 'Monthly cost estimates for the Inventory column. Billed per request, so opt-in.', status: 'active', milestone: 'M6', optional: true, readOnlyAccess: 'unverified' },
]

/** IAM action string, e.g. "ec2:DescribeInstances". */
export function actionOf(spec: AwsOperationSpec): string {
  return `${spec.service}:${spec.iamAction ?? spec.operation}`
}

/**
 * Built on first use rather than at module load.
 *
 * Every entry is `active` today, which leaves the guard's "registered but not
 * active" branch with no live example to test against. Deferring construction
 * lets a test add a planned entry and exercise that branch for real, rather
 * than the branch going uncovered the moment the backlog empties.
 */
let byKey: Map<string, AwsOperationSpec> | null = null

function index(): Map<string, AwsOperationSpec> {
  byKey ??= new Map(AWS_OPERATIONS.map((spec) => [`${spec.service}:${spec.operation}`, spec]))
  return byKey
}

/** Discards the cached index. Only needed after mutating the registry. */
export function resetOperationIndex(): void {
  byKey = null
}

export function findOperation(service: string, operation: string): AwsOperationSpec | undefined {
  return index().get(`${service}:${operation}`)
}

/**
 * Operation-name prefixes that are safe by construction. The guard requires a
 * match here *and* a registry entry — the prefix list alone would happily allow
 * a `GetSessionToken` or a `DescribeX` on a service we never meant to touch.
 */
export const READ_ONLY_PREFIXES = [
  'Describe',
  'List',
  'Get',
  'Search',
  'Select',
  'Lookup',
  'BatchGet',
] as const

/** Operations that read but do not start with a read-only prefix. */
export const READ_ONLY_EXCEPTIONS = new Set([
  'FilterLogEvents',
  'StartQuery',
  'StopQuery',
  'StartLiveTail',
])

export function hasReadOnlyShape(operation: string): boolean {
  if (READ_ONLY_EXCEPTIONS.has(operation)) return true
  return READ_ONLY_PREFIXES.some((prefix) => operation.startsWith(prefix))
}
