import type { CollectorFailure, MissingPermission } from '@cloudatlas/shared'
import type {
  InternetGateway,
  Instance,
  InstanceStatus,
  NatGateway,
  NetworkInterface,
  RouteTable,
  SecurityGroup as Ec2SecurityGroup,
  FlowLog,
  Subnet,
  Volume,
  Vpc,
} from '@aws-sdk/client-ec2'
import type {
  Listener,
  LoadBalancer,
  TagDescription,
  TargetGroup,
  TargetHealthDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import type { DBCluster, DBInstance } from '@aws-sdk/client-rds'
import type { CacheCluster, ReplicationGroup } from '@aws-sdk/client-elasticache'
import type { Cluster, Service, Task, TaskDefinition } from '@aws-sdk/client-ecs'
import type { MetricAlarm } from '@aws-sdk/client-cloudwatch'
import type { FunctionConfiguration, EventSourceMappingConfiguration } from '@aws-sdk/client-lambda'
import type { Firewall, FirewallMetadata, LoggingConfiguration } from '@aws-sdk/client-network-firewall'
import type { Bucket } from '@aws-sdk/client-s3'
import type { DistributionSummary } from '@aws-sdk/client-cloudfront'
import type { HostedZone, ResourceRecordSet } from '@aws-sdk/client-route-53'
import type { Role } from '@aws-sdk/client-iam'
import type {
  GetLoggingConfigurationResponse,
  WebACL,
  WebACLSummary,
} from '@aws-sdk/client-wafv2'
import type { AwsClient } from '../aws/client.js'
import { AbsentConfigurationError } from '../aws/errors.js'

/**
 * WAF's two scopes produce identically-shaped data, so both passes fill the
 * same fields. `Scope` and `Region` are carried on the summary because the
 * builder needs them to place the node and to call GetSampledRequests later,
 * and neither is recoverable from the ARN.
 */
export interface WafData {
  webAclSummaries: Array<WebACLSummary & { Scope: string; Region: string }>
  /** Keyed by web ACL ARN. */
  webAcls: Record<string, WebACL>
  /** Keyed by web ACL ARN. */
  webAclLogging: Record<string, GetLoggingConfigurationResponse>
  /** Keyed by web ACL ARN; REGIONAL only. */
  webAclResources: Record<string, string[]>
}

export function emptyWafData(): WafData {
  return { webAclSummaries: [], webAcls: {}, webAclLogging: {}, webAclResources: {} }
}

export interface CollectorContext {
  aws: AwsClient
  region: string
  accountId: string
  /** Records an AccessDenied without failing the scan. */
  onWarning: (warning: MissingPermission) => void
  /** Records a failure no classifier recognised, with the section it hit. */
  onFailure?: (failure: CollectorFailure) => void
  /** Called as each collector finishes, for the first-run progress stream. */
  onStep?: (step: string) => void
}

/**
 * Everything one region's collectors fetched, before any interpretation.
 *
 * Keeping collection and graph construction separate is what makes the
 * relationship builders testable: a replayed capture produces one of these, and
 * `graph/build.ts` is a pure function over it.
 */
export interface RegionScanData extends WafData {
  region: string

  // --- VPC ---
  vpcs: Vpc[]
  subnets: Subnet[]
  routeTables: RouteTable[]
  internetGateways: InternetGateway[]
  natGateways: NatGateway[]
  networkInterfaces: NetworkInterface[]
  securityGroups: Ec2SecurityGroup[]
  flowLogs: FlowLog[]

  // --- EC2 ---
  instances: Instance[]
  instanceStatuses: InstanceStatus[]
  volumes: Volume[]

  // --- ELBv2 ---
  loadBalancers: LoadBalancer[]
  listeners: Listener[]
  targetGroups: TargetGroup[]
  /** Keyed by target group ARN. */
  targetHealth: Record<string, TargetHealthDescription[]>
  /** Keyed by load balancer ARN. */
  loadBalancerTags: Record<string, TagDescription>

  // --- RDS ---
  dbInstances: DBInstance[]
  dbClusters: DBCluster[]

  // --- ElastiCache ---
  cacheClusters: CacheCluster[]
  replicationGroups: ReplicationGroup[]
  /** Keyed by cache cluster ARN. ElastiCache has no inline tags or batch API. */
  cacheClusterTags: Record<string, Array<{ Key?: string; Value?: string }>>

  // --- ECS ---
  ecsClusters: Cluster[]
  ecsServices: Service[]
  ecsTasks: Task[]
  /** Keyed by task definition ARN. */
  taskDefinitions: Record<string, TaskDefinition>

  // --- Lambda ---
  functions: FunctionConfiguration[]
  /** Keyed by function ARN. */
  functionTags: Record<string, Record<string, string>>
  eventSourceMappings: EventSourceMappingConfiguration[]

  // --- SQS ---
  /** Queue URLs; SQS has no ARN-first listing. */
  queueUrls: string[]
  /** Keyed by queue URL. */
  queueAttributes: Record<string, Record<string, string>>
  /** Keyed by queue URL. */
  queueTags: Record<string, Record<string, string>>

  // --- Network Firewall ---
  firewallMetadata: FirewallMetadata[]
  /** Keyed by firewall ARN. */
  firewalls: Record<string, Firewall>
  /** Keyed by firewall ARN. */
  firewallLogging: Record<string, LoggingConfiguration>

  // --- CloudWatch ---
  alarms: MetricAlarm[]

  /** Permissions this region's scan turned out not to have. */
  warnings: MissingPermission[]
  /** Calls that failed for a reason we could not classify. */
  failures: CollectorFailure[]
}

/**
 * Services with no region.
 *
 * S3, CloudFront, Route 53 and IAM are account-wide. Running them inside the
 * per-region loop would call each one once per selected region and produce a
 * duplicate node set per region — the same bucket appearing four times. They
 * get one pass, and their nodes live in the global lane.
 *
 * Buckets are the awkward case: `ListBuckets` is global but each bucket lives
 * in a region, so they are collected once here and placed by their own
 * location, not by the pass that found them.
 */
export interface GlobalScanData extends WafData {
  buckets: Bucket[]
  /** Keyed by bucket name. */
  bucketRegions: Record<string, string>
  /** Keyed by bucket name. */
  bucketTags: Record<string, Record<string, string>>
  /** Keyed by bucket name; null when the bucket has no default encryption. */
  bucketEncryption: Record<string, string | null>
  /** Keyed by bucket name. True only when all four blocks are on. */
  bucketPublicAccessBlocked: Record<string, boolean>
  /** Keyed by bucket name: ARNs the bucket sends events to. */
  bucketNotifications: Record<string, string[]>

  distributions: DistributionSummary[]
  hostedZones: HostedZone[]
  /** Keyed by hosted zone id. */
  recordSets: Record<string, ResourceRecordSet[]>
  roles: Role[]

  warnings: MissingPermission[]
  failures: CollectorFailure[]
}

export function emptyGlobalScanData(): GlobalScanData {
  return {
    ...emptyWafData(),
    buckets: [],
    bucketRegions: {},
    bucketTags: {},
    bucketEncryption: {},
    bucketPublicAccessBlocked: {},
    bucketNotifications: {},
    distributions: [],
    hostedZones: [],
    recordSets: {},
    roles: [],
    warnings: [],
    failures: [],
  }
}

export function emptyRegionScanData(region: string): RegionScanData {
  return {
    ...emptyWafData(),
    region,
    vpcs: [],
    subnets: [],
    routeTables: [],
    internetGateways: [],
    natGateways: [],
    networkInterfaces: [],
    securityGroups: [],
    flowLogs: [],
    instances: [],
    instanceStatuses: [],
    volumes: [],
    loadBalancers: [],
    listeners: [],
    targetGroups: [],
    targetHealth: {},
    loadBalancerTags: {},
    dbInstances: [],
    dbClusters: [],
    cacheClusters: [],
    replicationGroups: [],
    cacheClusterTags: {},
    ecsClusters: [],
    ecsServices: [],
    ecsTasks: [],
    taskDefinitions: {},
    functions: [],
    functionTags: {},
    eventSourceMappings: [],
    queueUrls: [],
    queueAttributes: {},
    queueTags: {},
    firewallMetadata: [],
    firewalls: {},
    firewallLogging: {},
    alarms: [],
    warnings: [],
    failures: [],
  }
}

/**
 * Run one collector call, degrading the section rather than the scan.
 *
 * Three outcomes:
 *   - a missing permission becomes a recorded warning and an empty result;
 *   - an AWS error we could not classify has already been recorded by the
 *     client, so it also becomes an empty result — losing one call's data beats
 *     losing the region, and the capture's meta.json reports the shape;
 *   - anything else is a bug in our own code and keeps propagating.
 */
/**
 * Run a call whose target configuration may simply not exist.
 *
 * `absent` is the value that *means* "not configured" for this field, so the
 * difference between "not set" and "could not read" survives into the graph
 * rather than both arriving as undefined. That distinction is the whole point:
 * a bucket with no public access block is not blocked, and a bucket we could
 * not ask about is unknown.
 */
export async function tolerateAbsent<T>(
  context: CollectorContext,
  section: string,
  fallback: T,
  absent: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AbsentConfigurationError) return absent
    return tolerate(context, section, fallback, () => Promise.reject(error))
  }
}

export async function tolerate<T>(
  context: CollectorContext,
  section: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const err = error as Error & { action?: string; name: string }

    if (err.name === 'AccessDeniedException') {
      context.onWarning({
        action: err.action ?? section,
        region: context.region,
        section,
        message: err.message,
      })
      return fallback
    }

    if (err.name === 'UnclassifiedAwsError') {
      // The client already recorded it; this adds the one thing it could not
      // know — which section of the UI goes quiet as a result.
      const unclassified = err as unknown as {
        service: string
        operation: string
        region: string
        errorName: string
        errorCode: string | null
        originalMessage: string
      }
      context.onFailure?.({
        service: unclassified.service,
        operation: unclassified.operation,
        region: unclassified.region,
        section,
        errorName: unclassified.errorName,
        errorCode: unclassified.errorCode,
        message: unclassified.originalMessage,
      })
      return fallback
    }

    throw error
  }
}
