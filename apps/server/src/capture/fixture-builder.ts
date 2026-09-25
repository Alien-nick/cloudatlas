import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptEntry } from '../aws/transcript.js'

/**
 * Hand-build a complete capture directory.
 *
 * This exists so the replay path — collectors, builders, diff — can be
 * exercised before any real fixture is committed. The call sequence mirrors
 * exactly what the collectors make, in order, which is also a readable
 * statement of that sequence.
 */

export interface FixtureOptions {
  region?: string
  accountId?: string
  /** Operations to record as AccessDenied rather than returning data. */
  deny?: string[]
  /** Operations to record as an unrecognised failure. */
  unclassify?: string[]
  /**
   * Shift every fake id and name by this amount, reproducing what redaction's
   * encounter-ordered numbering does when a denied call shortens the sequence.
   * The resources are the same; only their fakes moved.
   */
  idOffset?: number
  /** Append a second EC2 instance, simulating real account drift. */
  extraInstance?: boolean
}

const ACCOUNT = '111122223333'

function denialFor(service: string, operation: string, account: string): TranscriptEntry['error'] {
  return {
    name: service === 'ec2' ? 'UnauthorizedOperation' : 'AccessDenied',
    code: service === 'elasticache' ? 'AccessDenied' : undefined,
    message:
      `User: arn:aws:sts::${account}:assumed-role/principal-1 is not authorized to perform: ` +
      `${service}:${operation} on resource: arn:aws:${service}:us-east-1:${account}:resource-1`,
  } as TranscriptEntry['error']
}

export function writeFixture(dir: string, options: FixtureOptions = {}): string {
  const region = options.region ?? 'us-east-1'
  const account = options.accountId ?? ACCOUNT
  const deny = new Set(options.deny ?? [])
  const unclassify = new Set(options.unclassify ?? [])
  const offset = options.idOffset ?? 0

  /** A redacted resource id, e.g. rid('i', 1) -> "i-0000000001". */
  const rid = (prefix: string, n: number): string =>
    `${prefix}-${String(n + offset).padStart(10, '0')}`
  /** A redacted resource name, e.g. nm(4) -> "res-4". */
  const nm = (n: number): string => `res-${n + offset}`
  /** A redacted hostname, e.g. host(1, 'elb') -> "host-1.us-east-1.elb.amazonaws.com". */
  const host = (n: number, svc: string): string => `host-${n + offset}.${region}.${svc}.amazonaws.com`
  const lg = (n: number): string => `/redacted/lg-${n + offset}`

  const entries: TranscriptEntry[] = []
  const add = (service: string, operation: string, output: unknown): void => {
    const key = `${service}:${operation}`
    if (deny.has(key)) {
      entries.push({
        service,
        operation,
        region,
        input: {},
        output: null,
        durationMs: 5,
        error: denialFor(service, operation, account),
      })
      return
    }
    if (unclassify.has(key)) {
      entries.push({
        service,
        operation,
        region,
        input: {},
        output: null,
        durationMs: 5,
        error: {
          name: 'SomeServiceException',
          code: 'WeirdFault',
          message: 'a shape no classifier recognises',
        },
      })
      return
    }
    entries.push({ service, operation, region, input: {}, output, durationMs: 5 })
  }

  // --- identity ----------------------------------------------------------
  add('sts', 'GetCallerIdentity', {
    Account: account,
    Arn: `arn:aws:sts::${account}:assumed-role/principal-1`,
    UserId: 'AROAEXAMPLE:principal-1',
  })
  add('iam', 'ListAccountAliases', { AccountAliases: [nm(1)] })

  // --- vpc ---------------------------------------------------------------
  add('ec2', 'DescribeVpcs', {
    Vpcs: [{ VpcId: rid('vpc', 1), CidrBlock: '10.0.0.0/16', State: 'available', Tags: [{ Key: 'Name', Value: 'prod-vpc' }] }],
  })
  add('ec2', 'DescribeSubnets', {
    Subnets: [
      { SubnetId: rid('subnet', 1), VpcId: rid('vpc', 1), AvailabilityZone: `${region}a`, CidrBlock: '10.0.1.0/24', State: 'available', AvailableIpAddressCount: 250, Tags: [{ Key: 'Name', Value: 'public-1a' }] },
      { SubnetId: rid('subnet', 2), VpcId: rid('vpc', 1), AvailabilityZone: `${region}a`, CidrBlock: '10.0.11.0/24', State: 'available', AvailableIpAddressCount: 240, Tags: [{ Key: 'Name', Value: 'private-1a' }] },
    ],
  })
  add('ec2', 'DescribeRouteTables', {
    RouteTables: [
      { VpcId: rid('vpc', 1), Associations: [{ SubnetId: rid('subnet', 1) }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: rid('igw', 1) }] },
      { VpcId: rid('vpc', 1), Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: rid('nat', 1) }] },
    ],
  })
  add('ec2', 'DescribeInternetGateways', { InternetGateways: [{ InternetGatewayId: rid('igw', 1) }] })
  add('ec2', 'DescribeNatGateways', {
    NatGateways: [{ NatGatewayId: rid('nat', 1), VpcId: rid('vpc', 1), SubnetId: rid('subnet', 1), State: 'available', NatGatewayAddresses: [{ PrivateIp: '10.0.1.9', PublicIp: '203.0.113.1' }] }],
  })
  add('ec2', 'DescribeNetworkInterfaces', {
    NetworkInterfaces: [{ NetworkInterfaceId: rid('eni', 1), PrivateIpAddress: '10.0.11.41', Attachment: { InstanceId: rid('i', 1) } }],
  })
  add('ec2', 'DescribeSecurityGroups', {
    SecurityGroups: [
      { GroupId: rid('sg', 1), GroupName: nm(2), VpcId: rid('vpc', 1), Description: 'description-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }], IpPermissionsEgress: [] },
      { GroupId: rid('sg', 2), GroupName: nm(3), VpcId: rid('vpc', 1), Description: 'description-2', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }], IpPermissionsEgress: [] },
    ],
  })

  // --- ec2 ---------------------------------------------------------------
  add('ec2', 'DescribeInstances', {
    Reservations: [{
      OwnerId: account,
      Instances: [{
        InstanceId: rid('i', 1), InstanceType: 'm6i.xlarge', State: { Name: 'running' },
        VpcId: rid('vpc', 1), SubnetId: rid('subnet', 2), PrivateIpAddress: '10.0.11.41',
        Placement: { AvailabilityZone: `${region}a` }, ImageId: rid('ami', 1),
        MetadataOptions: { HttpTokens: 'optional' },
        SecurityGroups: [{ GroupId: rid('sg', 2) }],
        Tags: [{ Key: 'Name', Value: 'legacy-worker' }],
        LaunchTime: '2026-09-01T00:00:00.000Z',
      },
      ...(options.extraInstance
        ? [{
            InstanceId: rid('i', 2), InstanceType: 'c6i.large', State: { Name: 'running' },
            VpcId: rid('vpc', 1), SubnetId: rid('subnet', 2), PrivateIpAddress: '10.0.11.99',
            Placement: { AvailabilityZone: `${region}a` }, ImageId: rid('ami', 1),
            MetadataOptions: { HttpTokens: 'required' },
            SecurityGroups: [{ GroupId: rid('sg', 2) }],
            Tags: [{ Key: 'Name', Value: 'new-worker' }],
            LaunchTime: '2026-09-20T00:00:00.000Z',
          }]
        : []),
      ],
    }],
  })
  add('ec2', 'DescribeInstanceStatus', {
    InstanceStatuses: [{ InstanceId: rid('i', 1), InstanceStatus: { Status: 'ok' }, SystemStatus: { Status: 'ok' } }],
  })
  add('ec2', 'DescribeVolumes', {
    Volumes: [{ VolumeId: rid('vol', 1), Size: 80, VolumeType: 'gp3', Attachments: [{ InstanceId: rid('i', 1) }] }],
  })

  // --- elbv2 -------------------------------------------------------------
  const lbArn = `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/${nm(4)}/0000000001`
  const tgArn = `arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/${nm(5)}/0000000002`
  add('elasticloadbalancing', 'DescribeLoadBalancers', {
    LoadBalancers: [{ LoadBalancerArn: lbArn, LoadBalancerName: nm(4), VpcId: rid('vpc', 1), Type: 'application', Scheme: 'internet-facing', DNSName: host(1, 'elb'), SecurityGroups: [rid('sg', 1)], AvailabilityZones: [{ ZoneName: `${region}a`, SubnetId: rid('subnet', 1) }], State: { Code: 'active' } }],
  })
  add('elasticloadbalancing', 'DescribeTargetGroups', {
    TargetGroups: [{ TargetGroupArn: tgArn, TargetGroupName: nm(5), Port: 8080, LoadBalancerArns: [lbArn] }],
  })
  add('elasticloadbalancing', 'DescribeListeners', {
    Listeners: [{ LoadBalancerArn: lbArn, Protocol: 'HTTPS', Port: 443 }],
  })
  add('elasticloadbalancing', 'DescribeTargetHealth', {
    TargetHealthDescriptions: [{ Target: { Id: rid('i', 1), Port: 8080 }, TargetHealth: { State: 'healthy' } }],
  })
  add('elasticloadbalancing', 'DescribeTags', {
    TagDescriptions: [{ ResourceArn: lbArn, Tags: [{ Key: 'Name', Value: 'api-alb' }] }],
  })

  // --- rds ---------------------------------------------------------------
  add('rds', 'DescribeDBInstances', {
    DBInstances: [
      { DBInstanceIdentifier: nm(6), DBInstanceStatus: 'available', Engine: 'postgres', EngineVersion: '15.4', DBInstanceClass: 'db.r6g.2xlarge', AvailabilityZone: `${region}a`, DBSubnetGroup: { VpcId: rid('vpc', 1), Subnets: [{ SubnetIdentifier: rid('subnet', 2), SubnetAvailabilityZone: { Name: `${region}a` } }] }, Endpoint: { Address: host(2, 'rds'), Port: 5432 }, EnabledCloudwatchLogsExports: ['postgresql'], StorageEncrypted: true, PubliclyAccessible: false, VpcSecurityGroups: [{ VpcSecurityGroupId: rid('sg', 1) }], TagList: [{ Key: 'Name', Value: 'prod-pg' }] },
      { DBInstanceIdentifier: nm(7), DBInstanceStatus: 'available', Engine: 'postgres', ReadReplicaSourceDBInstanceIdentifier: nm(6), DBSubnetGroup: { VpcId: rid('vpc', 1), Subnets: [] }, Endpoint: { Port: 5432 }, TagList: [] },
    ],
  })
  add('rds', 'DescribeDBClusters', { DBClusters: [] })

  // --- elasticache -------------------------------------------------------
  add('elasticache', 'DescribeCacheClusters', {
    CacheClusters: [{ CacheClusterId: nm(8), CacheClusterStatus: 'available', Engine: 'redis', CacheNodeType: 'cache.r6g.large', PreferredAvailabilityZone: `${region}a`, ARN: `arn:aws:elasticache:${region}:${account}:cluster:${nm(8)}`, SecurityGroups: [{ SecurityGroupId: rid('sg', 1) }] }],
  })
  add('elasticache', 'DescribeReplicationGroups', { ReplicationGroups: [] })
  if (!deny.has('elasticache:DescribeCacheClusters')) {
    add('elasticache', 'ListTagsForResource', { TagList: [{ Key: 'Name', Value: 'cache' }] })
  }

  // --- ecs ---------------------------------------------------------------
  const clusterArn = `arn:aws:ecs:${region}:${account}:cluster/${nm(9)}`
  const taskArn = `arn:aws:ecs:${region}:${account}:task/${nm(9)}/0000000003`
  const tdArn = `arn:aws:ecs:${region}:${account}:task-definition/${nm(10)}:7`
  add('ecs', 'ListClusters', { clusterArns: [clusterArn] })
  add('ecs', 'DescribeClusters', { clusters: [{ clusterArn, clusterName: nm(9) }] })
  add('ecs', 'ListServices', { serviceArns: [] })
  add('ecs', 'ListTasks', { taskArns: [taskArn] })
  add('ecs', 'DescribeTasks', {
    tasks: [{ taskArn, clusterArn, taskDefinitionArn: tdArn, lastStatus: 'RUNNING', launchType: 'FARGATE', availabilityZone: `${region}a`, cpu: '1024', memory: '2048', attachments: [{ details: [{ name: 'subnetId', value: rid('subnet', 2) }, { name: 'privateIPv4Address', value: '10.0.11.58' }] }], tags: [] }],
  })
  add('ecs', 'DescribeTaskDefinition', {
    taskDefinition: { containerDefinitions: [{ name: 'api', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': lg(1) } } }] },
  })

  // --- vpc flow logs -----------------------------------------------------
  // Delivered to S3 rather than CloudWatch: the case where the Logs tab is
  // legitimately empty but flow logging is on.
  add('ec2', 'DescribeFlowLogs', {
    FlowLogs: [
      { FlowLogId: 'fl-0000000001', ResourceId: rid('vpc', 1), LogDestinationType: 's3', LogDestination: `arn:aws:s3:::${nm(15)}`, FlowLogStatus: 'ACTIVE', TrafficType: 'ALL' },
    ],
  })

  // --- lambda ------------------------------------------------------------
  const fnArn = `arn:aws:lambda:${region}:${account}:function:${nm(12)}`
  const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${nm(13)}`
  const queueArn = `arn:aws:sqs:${region}:${account}:${nm(13)}`
  add('lambda', 'ListFunctions', {
    Functions: [{ FunctionName: nm(12), FunctionArn: fnArn, Runtime: 'nodejs22.x', MemorySize: 512, Timeout: 30, Handler: 'index.handler', State: 'Active', Role: `arn:aws:iam::${account}:role/${nm(14)}`, LastModified: '2026-09-01T00:00:00.000+0000' }],
  })
  // The mapping is what produces the SQS -> Lambda event edge.
  add('lambda', 'ListEventSourceMappings', {
    EventSourceMappings: [{ UUID: '00000000-0000-4000-8000-000000000001', EventSourceArn: queueArn, FunctionArn: fnArn, State: 'Enabled', BatchSize: 10 }],
  })
  add('lambda', 'ListTags', { Tags: { Name: 'worker' } })

  // --- sqs ---------------------------------------------------------------
  add('sqs', 'ListQueues', { QueueUrls: [queueUrl] })
  add('sqs', 'GetQueueAttributes', {
    Attributes: { QueueArn: queueArn, ApproximateNumberOfMessages: '4', VisibilityTimeout: '30', SqsManagedSseEnabled: 'true', CreatedTimestamp: '1758326400' },
  })
  add('sqs', 'ListQueueTags', { Tags: { Name: 'jobs' } })

  // --- network firewall --------------------------------------------------
  // Most accounts have none, which is the case worth having in the fixture:
  // the collector must cost exactly one call and produce no nodes.
  add('network-firewall', 'ListFirewalls', { Firewalls: [] })

  // --- waf (REGIONAL) ----------------------------------------------------
  const regionalAclArn = `arn:aws:wafv2:${region}:${account}:regional/webacl/${nm(17)}/0000000001`
  add('wafv2', 'ListWebACLs', {
    WebACLs: [{ Name: nm(17), Id: '0000000001', ARN: regionalAclArn, Description: 'regional acl' }],
  })
  add('wafv2', 'GetWebACL', {
    WebACL: {
      Name: nm(17), Id: '0000000001', ARN: regionalAclArn, Capacity: 700,
      DefaultAction: { Allow: {} },
      Rules: [
        { Name: 'aws-common', Priority: 0, Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } }, VisibilityConfig: { MetricName: 'aws-common', SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true } },
        { Name: 'rate-limit', Priority: 1, Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } }, VisibilityConfig: { MetricName: 'rate-limit', SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true } },
      ],
    },
  })
  add('wafv2', 'GetLoggingConfiguration', {
    LoggingConfiguration: { ResourceArn: regionalAclArn, LogDestinationConfigs: [`arn:aws:logs:${region}:${account}:log-group:${lg(2)}`] },
  })
  // The association is what produces the web ACL -> load balancer edge.
  add('wafv2', 'ListResourcesForWebACL', { ResourceArns: [lbArn] })

  // --- cloudwatch --------------------------------------------------------
  add('cloudwatch', 'DescribeAlarms', {
    MetricAlarms: [{ AlarmName: nm(11), Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', StateValue: 'OK', StateReason: 'within threshold', Dimensions: [{ Name: 'InstanceId', Value: rid('i', 1) }] }],
  })

  // --- global services ---------------------------------------------------
  // Recorded against the 'global' pseudo-region, which is what scanGlobal uses
  // so an account-wide call is never attributed to a region the user picked.
  const globalEntries: TranscriptEntry[] = []
  const addGlobal = (service: string, operation: string, output: unknown): void => {
    const key = `${service}:${operation}`
    if (deny.has(key)) {
      globalEntries.push({ region: 'global', service, operation, error: denialFor(service, operation, account) } as TranscriptEntry)
      return
    }
    if (unclassify.has(key)) {
      globalEntries.push({ region: 'global', service, operation, error: { name: 'WeirdServiceException', message: 'something unrecognised' } } as TranscriptEntry)
      return
    }
    globalEntries.push({ region: 'global', service, operation, output } as TranscriptEntry)
  }

  const bucket = nm(15)
  addGlobal('s3', 'ListBuckets', { Buckets: [{ Name: bucket, CreationDate: '2026-01-01T00:00:00.000Z' }] })
  // A null LocationConstraint means us-east-1, which is the quirk most likely
  // to be mishandled.
  addGlobal('s3', 'GetBucketLocation', { LocationConstraint: null })
  // Everything after the location lookup is addressed to the bucket's own
  // region, not to the global endpoint: an S3 call sent to the wrong region is
  // rejected with a redirect, so the capture has to record it where it is made.
  add('s3', 'GetBucketTagging', { TagSet: [{ Key: 'Name', Value: 'assets' }] })
  add('s3', 'GetBucketEncryption', {
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] },
  })
  add('s3', 'GetBucketNotificationConfiguration', {
    QueueConfigurations: [{ Id: 'to-queue', QueueArn: queueArn, Events: ['s3:ObjectCreated:*'] }],
  })
  add('s3', 'GetPublicAccessBlock', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  })
  const globalAclArn = `arn:aws:wafv2:us-east-1:${account}:global/webacl/${nm(18)}/0000000002`
  addGlobal('cloudfront', 'ListDistributions', {
    DistributionList: { IsTruncated: false, Items: [{ Id: 'E0000000000001', ARN: `arn:aws:cloudfront::${account}:distribution/E0000000000001`, DomainName: `${nm(16)}.cloudfront.net`, Enabled: true, Status: 'Deployed', Aliases: { Quantity: 0, Items: [] }, Origins: { Quantity: 1, Items: [{ Id: 'origin-1', DomainName: host(1, 'elb') }] }, WebACLId: globalAclArn }] },
  })
  addGlobal('route53', 'ListHostedZones', {
    IsTruncated: false,
    HostedZones: [{ Id: '/hostedzone/Z0000000000001', Name: 'example-1.test.', ResourceRecordSetCount: 2 }],
  })
  addGlobal('route53', 'ListResourceRecordSets', {
    IsTruncated: false,
    ResourceRecordSets: [
      { Name: 'example-1.test.', Type: 'A', AliasTarget: { DNSName: `${nm(16)}.cloudfront.net.`, HostedZoneId: 'Z2FDTNDATAQYW2', EvaluateTargetHealth: false } },
      { Name: 'example-1.test.', Type: 'TXT', ResourceRecords: [{ Value: '"v=spf1 -all"' }] },
    ],
  })
  addGlobal('wafv2', 'ListWebACLs', {
    WebACLs: [{ Name: nm(18), Id: '0000000002', ARN: globalAclArn, Description: 'cloudfront acl' }],
  })
  addGlobal('wafv2', 'GetWebACL', {
    WebACL: {
      Name: nm(18), Id: '0000000002', ARN: globalAclArn, Capacity: 300,
      DefaultAction: { Block: {} },
      Rules: [{ Name: 'geo', Priority: 0, Statement: {}, VisibilityConfig: { MetricName: 'geo', SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true } }],
    },
  })
  addGlobal('wafv2', 'GetLoggingConfiguration', {})

  addGlobal('iam', 'ListRoles', {
    IsTruncated: false,
    Roles: [{ RoleName: nm(14), Arn: `arn:aws:iam::${account}:role/${nm(14)}`, Path: '/', CreateDate: '2026-01-01T00:00:00.000Z', AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] })) }],
  })

  // --- write -------------------------------------------------------------
  mkdirSync(join(dir, region), { recursive: true })
  mkdirSync(join(dir, 'global'), { recursive: true })
  const globalGrouped = new Map<string, TranscriptEntry[]>()
  for (const entry of globalEntries) {
    const key = `${entry.service}.${entry.operation}`
    const list = globalGrouped.get(key)
    if (list) list.push(entry)
    else globalGrouped.set(key, [entry])
  }
  for (const [key, list] of globalGrouped) {
    writeFileSync(join(dir, 'global', `${key}.json`), `${JSON.stringify(list, null, 2)}\n`)
  }
  const grouped = new Map<string, TranscriptEntry[]>()
  for (const entry of entries) {
    const key = `${entry.service}.${entry.operation}`
    const list = grouped.get(key)
    if (list) list.push(entry)
    else grouped.set(key, [entry])
  }
  for (const [key, list] of grouped) {
    writeFileSync(join(dir, region, `${key}.json`), `${JSON.stringify(list, null, 2)}\n`)
  }
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ name: 'synthetic', capturedAt: '2026-09-20T00:00:00.000Z', regions: [region], totalCalls: entries.length + globalEntries.length }, null, 2)}\n`,
  )
  return dir
}
