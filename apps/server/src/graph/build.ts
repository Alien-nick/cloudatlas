import {
  type Alarm,
  type GraphEdge,
  type GraphNode,
  type SecurityGroup,
  type SecurityGroupRule,
  type TargetGroupRef,
} from '@cloudatlas/shared'
import type { RouteTable, Subnet } from '@aws-sdk/client-ec2'
import type { MetricAlarm } from '@aws-sdk/client-cloudwatch'
import type { GlobalScanData, RegionScanData } from '../collectors/types.js'
import { POSTURE_FACTS } from './posture-facts.js'
import { targetGroupDimension } from '../metrics/dimensions.js'
import { buildBucketNodes, buildRegionalServiceNodes, buildWebAclNodes } from './services.js'
import {
  azId,
  displayName,
  ebsEncryptionFact,
  lastSegment,
  laneId,
  node,
  prop,
  props,
  regionId,
  serviceNameOf,
  toTags,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Where a VPC's flow log records are delivered, or that there are none. */
function describeFlowLogs(
  flowLogs: Array<{ LogDestinationType?: string; LogGroupName?: string; LogDestination?: string; FlowLogStatus?: string }>,
): string {
  if (flowLogs.length === 0) return 'not enabled'
  return flowLogs
    .map((flowLog) => {
      const target =
        flowLog.LogDestinationType === 'cloud-watch-logs'
          ? (flowLog.LogGroupName ?? 'cloudwatch')
          : (flowLog.LogDestination ?? flowLog.LogDestinationType ?? 'unknown')
      const status = flowLog.FlowLogStatus && flowLog.FlowLogStatus !== 'ACTIVE' ? ` (${flowLog.FlowLogStatus})` : ''
      return `${flowLog.LogDestinationType ?? 'unknown'}:${target}${status}`
    })
    .join(', ')
}

// ---------------------------------------------------------------------------
// Subnet classification
// ---------------------------------------------------------------------------

/**
 * A subnet is public when its associated route table sends 0.0.0.0/0 to an
 * internet gateway. Subnets with no explicit association inherit the VPC's main
 * route table, which is the case the naive implementation gets wrong.
 */
export function isPublicSubnet(subnet: Subnet, routeTables: RouteTable[]): boolean {
  const explicit = routeTables.find((table) =>
    table.Associations?.some((association) => association.SubnetId === subnet.SubnetId),
  )
  const main = routeTables.find(
    (table) =>
      table.VpcId === subnet.VpcId && table.Associations?.some((a) => a.Main === true),
  )
  const table = explicit ?? main
  if (!table) return false

  return (table.Routes ?? []).some(
    (route) =>
      (route.DestinationCidrBlock === '0.0.0.0/0' || route.DestinationIpv6CidrBlock === '::/0') &&
      typeof route.GatewayId === 'string' &&
      route.GatewayId.startsWith('igw-'),
  )
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export interface BuiltRegion {
  nodes: GraphNode[]
  edges: GraphEdge[]
  securityGroups: SecurityGroup[]
  alarms: Alarm[]
  /** Non-container resources, for the region count. */
  resourceCount: number
}

export function buildRegionGraph(
  data: RegionScanData,
  accountId: string,
  global?: GlobalScanData,
): BuiltRegion {
  const { region } = data
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  // --- containers --------------------------------------------------------
  nodes.push(
    node({
      id: regionId(region),
      type: 'region',
      category: 'network',
      name: `Region · ${region}`,
      abbr: 'R',
      typeLabel: 'AWS Region',
      region,
      parentId: null,
      state: 'active',
      raw: { region },
    }),
  )

  const vpcById = new Map(data.vpcs.map((vpc) => [vpc.VpcId ?? '', vpc]))

  // Flow logs, indexed by the resource they cover.
  const flowLogsByResource = new Map<string, typeof data.flowLogs>()
  for (const flowLog of data.flowLogs) {
    if (!flowLog.ResourceId) continue
    const list = flowLogsByResource.get(flowLog.ResourceId) ?? []
    list.push(flowLog)
    flowLogsByResource.set(flowLog.ResourceId, list)
  }
  for (const vpc of data.vpcs) {
    if (!vpc.VpcId) continue
    const tags = toTags(vpc.Tags)
    nodes.push(
      node({
        id: vpc.VpcId,
        type: 'vpc',
        category: 'network',
        name: displayName(tags, vpc.VpcId),
        abbr: 'V',
        typeLabel: 'VPC',
        region,
        vpcId: vpc.VpcId,
        parentId: regionId(region),
        state: vpc.State ?? 'available',
        tags,
        cidr: vpc.CidrBlock,
        arn: `arn:aws:ec2:${region}:${accountId}:vpc/${vpc.VpcId}`,
        consoleId: vpc.VpcId,
        raw: vpc,
        logGroups: (flowLogsByResource.get(vpc.VpcId) ?? [])
          .filter((flowLog) => flowLog.LogDestinationType === 'cloud-watch-logs')
          .map((flowLog) => flowLog.LogGroupName)
          .filter((name): name is string => typeof name === 'string'),
        props: props([
          prop('VPC ID', vpc.VpcId),
          prop('CIDR', vpc.CidrBlock),
          // Named rather than omitted: flow logs delivered to S3 are still on,
          // and an empty Logs tab would read as "flow logs are disabled".
          prop('Flow logs', describeFlowLogs(flowLogsByResource.get(vpc.VpcId) ?? [])),
          prop('Tenancy', vpc.InstanceTenancy),
          prop('Default VPC', vpc.IsDefault ? 'yes' : 'no'),
        ]),
      }),
    )
  }

  // AZ containers are synthetic: one per (vpc, az) that actually holds a subnet.
  const azSeen = new Set<string>()
  for (const subnet of data.subnets) {
    if (!subnet.VpcId || !subnet.AvailabilityZone || !vpcById.has(subnet.VpcId)) continue
    const id = azId(subnet.VpcId, subnet.AvailabilityZone)
    if (azSeen.has(id)) continue
    azSeen.add(id)
    nodes.push(
      node({
        id,
        type: 'az',
        category: 'network',
        name: `AZ ${subnet.AvailabilityZone}`,
        abbr: 'AZ',
        typeLabel: 'Availability Zone',
        region,
        az: subnet.AvailabilityZone,
        vpcId: subnet.VpcId,
        parentId: subnet.VpcId,
        state: 'available',
        raw: { availabilityZone: subnet.AvailabilityZone, availabilityZoneId: subnet.AvailabilityZoneId },
        props: props([
          prop('Zone name', subnet.AvailabilityZone),
          // The zone *id* is the physically stable one. Zone names are
          // per-account aliases, so one account's us-east-1a is a different
          // datacentre from another's — which matters the moment anything is
          // compared across accounts.
          prop('Zone ID', subnet.AvailabilityZoneId),
        ]),
      }),
    )
  }

  const subnetById = new Map<string, Subnet>()
  for (const subnet of data.subnets) {
    if (!subnet.SubnetId || !subnet.VpcId || !subnet.AvailabilityZone) continue
    subnetById.set(subnet.SubnetId, subnet)
    const tags = toTags(subnet.Tags)
    const isPublic = isPublicSubnet(subnet, data.routeTables)
    nodes.push(
      node({
        id: subnet.SubnetId,
        type: 'subnet',
        category: 'network',
        name: displayName(tags, subnet.SubnetId),
        abbr: 'SN',
        typeLabel: isPublic ? 'Public subnet' : 'Private subnet',
        region,
        az: subnet.AvailabilityZone,
        vpcId: subnet.VpcId,
        subnetId: subnet.SubnetId,
        parentId: azId(subnet.VpcId, subnet.AvailabilityZone),
        state: subnet.State ?? 'available',
        tags,
        cidr: subnet.CidrBlock,
        isPublic,
        arn: subnet.SubnetArn ?? null,
        consoleId: subnet.SubnetId,
        raw: subnet,
        props: props([
          prop('Subnet ID', subnet.SubnetId),
          prop('CIDR', subnet.CidrBlock),
          prop('Availability zone', subnet.AvailabilityZone),
          prop('Route to internet', isPublic ? '0.0.0.0/0 → internet gateway' : 'via NAT or none'),
          prop('Available IPs', subnet.AvailableIpAddressCount),
          prop('Auto-assign public IP', subnet.MapPublicIpOnLaunch ? 'enabled' : 'disabled'),
        ]),
      }),
    )
  }

  /** Place a resource as deep in the hierarchy as we can identify. */
  const placement = (
    vpcId: string | undefined,
    subnetId: string | undefined,
    az: string | undefined,
  ): { parentId: string; vpcId: string | null; subnetId: string | null; az: string | null } => {
    if (subnetId && subnetById.has(subnetId)) {
      const subnet = subnetById.get(subnetId)
      return {
        parentId: subnetId,
        vpcId: subnet?.VpcId ?? vpcId ?? null,
        subnetId,
        az: subnet?.AvailabilityZone ?? az ?? null,
      }
    }
    if (vpcId && az && azSeen.has(azId(vpcId, az))) {
      return { parentId: azId(vpcId, az), vpcId, subnetId: null, az }
    }
    if (vpcId && vpcById.has(vpcId)) {
      return { parentId: vpcId, vpcId, subnetId: null, az: az ?? null }
    }
    return { parentId: laneId(region), vpcId: vpcId ?? null, subnetId: null, az: az ?? null }
  }

  let needsLane = false

  // --- security groups ---------------------------------------------------
  const securityGroups: SecurityGroup[] = data.securityGroups.map((sg) => ({
    id: sg.GroupId ?? '',
    name: sg.GroupName ?? sg.GroupId ?? '',
    description: sg.Description,
    vpcId: sg.VpcId ?? null,
    rules: [
      ...(sg.IpPermissions ?? []).flatMap((perm) => flattenRule(perm, 'in')),
      ...(sg.IpPermissionsEgress ?? []).flatMap((perm) => flattenRule(perm, 'out')),
    ],
  }))

  // --- NAT gateways ------------------------------------------------------
  for (const nat of data.natGateways) {
    if (!nat.NatGatewayId) continue
    if (nat.State === 'deleted' || nat.State === 'failed') continue
    const tags = toTags(nat.Tags)
    const place = placement(nat.VpcId, nat.SubnetId, undefined)
    const privateIp = nat.NatGatewayAddresses?.[0]?.PrivateIp
    nodes.push(
      node({
        id: nat.NatGatewayId,
        type: 'nat-gateway',
        category: 'network',
        name: displayName(tags, nat.NatGatewayId),
        abbr: 'NAT',
        subtitle: privateIp ? `NAT GW · ${privateIp}` : 'NAT Gateway',
        typeLabel: 'NAT Gateway',
        region,
        ...place,
        state: nat.State ?? 'available',
        tags,
        arn: `arn:aws:ec2:${region}:${accountId}:natgateway/${nat.NatGatewayId}`,
        consoleId: nat.NatGatewayId,
        raw: nat,
        props: props([
          prop('NAT Gateway ID', nat.NatGatewayId),
          prop('Connectivity', nat.ConnectivityType ?? 'public'),
          prop('Public IP', nat.NatGatewayAddresses?.[0]?.PublicIp),
          prop('Private IP', privateIp),
          prop('Subnet', nat.SubnetId),
        ]),
      }),
    )
  }

  // --- EC2 ---------------------------------------------------------------
  const statusById = new Map(data.instanceStatuses.map((s) => [s.InstanceId ?? '', s]))
  const volumesByInstance = new Map<string, typeof data.volumes>()
  for (const volume of data.volumes) {
    for (const attachment of volume.Attachments ?? []) {
      if (!attachment.InstanceId) continue
      const list = volumesByInstance.get(attachment.InstanceId) ?? []
      list.push(volume)
      volumesByInstance.set(attachment.InstanceId, list)
    }
  }

  for (const instance of data.instances) {
    if (!instance.InstanceId) continue
    const tags = toTags(instance.Tags)
    const place = placement(instance.VpcId, instance.SubnetId, instance.Placement?.AvailabilityZone)
    const status = statusById.get(instance.InstanceId)
    const volumes = volumesByInstance.get(instance.InstanceId) ?? []
    const state = instance.State?.Name ?? 'unknown'

    nodes.push(
      node({
        id: instance.InstanceId,
        type: 'ec2',
        category: 'compute',
        name: displayName(tags, instance.InstanceId),
        abbr: 'EC2',
        subtitle: [instance.InstanceType, instance.PrivateIpAddress].filter(Boolean).join(' · '),
        typeLabel: 'EC2 instance',
        region,
        ...place,
        state,
        tags,
        arn: `arn:aws:ec2:${region}:${accountId}:instance/${instance.InstanceId}`,
        consoleId: instance.InstanceId,
        securityGroupIds: (instance.SecurityGroups ?? [])
          .map((sg) => sg.GroupId)
          .filter((id): id is string => typeof id === 'string'),
        raw: instance,
        props: props([
          prop('Instance ID', instance.InstanceId),
          prop('Instance type', instance.InstanceType),
          prop('State', state),
          prop('Private IPv4', instance.PrivateIpAddress),
          prop('Public IPv4', instance.PublicIpAddress ?? '— (none)'),
          prop('Availability zone', instance.Placement?.AvailabilityZone),
          prop('AMI', instance.ImageId),
          prop('Key pair', instance.KeyName),
          prop('IAM instance profile', instance.IamInstanceProfile?.Arn),
          // Read by the IMDSv1 posture detector; see graph/posture-facts.ts.
          prop(
            POSTURE_FACTS.imds.key,
            instance.MetadataOptions?.HttpTokens === 'required'
              ? POSTURE_FACTS.imds.v2Required
              : POSTURE_FACTS.imds.v1Allowed,
          ),
          prop(
            'EBS',
            volumes
              .map((v) => `${v.VolumeId} ${v.Size ?? '?'} GiB ${v.VolumeType ?? ''}`.trim())
              .join(', '),
          ),
          prop(POSTURE_FACTS.ebsEncryption.key, ebsEncryptionFact(volumes)),
          prop(
            'Status checks',
            status
              ? `instance ${status.InstanceStatus?.Status ?? '?'} · system ${status.SystemStatus?.Status ?? '?'}`
              : undefined,
          ),
          prop('Launched', instance.LaunchTime ? new Date(instance.LaunchTime).toISOString() : undefined),
        ]),
      }),
    )
  }

  // --- ELBv2 -------------------------------------------------------------
  const targetGroupsByLb = new Map<string, TargetGroupRef[]>()
  for (const tg of data.targetGroups) {
    if (!tg.TargetGroupArn) continue
    const dimension = targetGroupDimension(tg.TargetGroupArn)
    if (!dimension) continue
    const ref = { name: tg.TargetGroupName ?? lastSegment(tg.TargetGroupArn), dimension }
    for (const lbArn of tg.LoadBalancerArns ?? []) {
      const list = targetGroupsByLb.get(lbArn) ?? []
      list.push(ref)
      targetGroupsByLb.set(lbArn, list)
    }
  }

  const listenersByLb = new Map<string, typeof data.listeners>()
  for (const listener of data.listeners) {
    if (!listener.LoadBalancerArn) continue
    const list = listenersByLb.get(listener.LoadBalancerArn) ?? []
    list.push(listener)
    listenersByLb.set(listener.LoadBalancerArn, list)
  }

  for (const lb of data.loadBalancers) {
    if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue
    const tags = toTags(data.loadBalancerTags[lb.LoadBalancerArn]?.Tags)
    // A load balancer spans subnets; anchor it in the first for layout, and
    // list them all in the detail panel.
    const subnetIds = (lb.AvailabilityZones ?? [])
      .map((az) => az.SubnetId)
      .filter((id): id is string => typeof id === 'string')
    const place = placement(lb.VpcId, subnetIds[0], lb.AvailabilityZones?.[0]?.ZoneName)
    const listeners = listenersByLb.get(lb.LoadBalancerArn) ?? []
    const isNlb = lb.Type === 'network'

    nodes.push(
      node({
        id: lb.LoadBalancerArn,
        type: isNlb ? 'nlb' : 'alb',
        category: 'network',
        name: lb.LoadBalancerName,
        abbr: isNlb ? 'NLB' : 'ALB',
        subtitle: lb.Scheme === 'internet-facing' ? 'internet-facing' : 'internal',
        typeLabel: isNlb ? 'Network Load Balancer' : 'Application Load Balancer',
        region,
        ...place,
        state: lb.State?.Code ?? 'active',
        tags,
        arn: lb.LoadBalancerArn,
        consoleId: lb.LoadBalancerName,
        securityGroupIds: lb.SecurityGroups ?? [],
        targetGroups: targetGroupsByLb.get(lb.LoadBalancerArn) ?? [],
        raw: lb,
        props: props([
          prop('DNS name', lb.DNSName),
          prop('Scheme', lb.Scheme),
          prop('Type', lb.Type),
          prop(
            'Listeners',
            listeners.map((l) => `${l.Protocol ?? ''}:${l.Port ?? ''}`).join(', '),
          ),
          prop('Subnets', subnetIds.join(', ')),
          prop('Availability zones', (lb.AvailabilityZones ?? []).map((az) => az.ZoneName).join(', ')),
          prop('IP address type', lb.IpAddressType),
          prop('Created', lb.CreatedTime ? new Date(lb.CreatedTime).toISOString() : undefined),
        ]),
      }),
    )
  }

  // --- RDS ---------------------------------------------------------------
  for (const db of data.dbInstances) {
    if (!db.DBInstanceIdentifier) continue
    const tags = toTags(db.TagList)
    const subnetId = (db.DBSubnetGroup?.Subnets ?? []).find(
      (s) => s.SubnetAvailabilityZone?.Name === db.AvailabilityZone,
    )?.SubnetIdentifier
    const place = placement(db.DBSubnetGroup?.VpcId, subnetId, db.AvailabilityZone)

    nodes.push(
      node({
        id: db.DBInstanceIdentifier,
        type: 'rds',
        category: 'database',
        name: db.DBInstanceIdentifier,
        abbr: 'RDS',
        subtitle: db.DBInstanceClass,
        typeLabel: `RDS ${db.Engine ?? ''} instance`.replace('  ', ' '),
        region,
        ...place,
        state: db.DBInstanceStatus ?? 'unknown',
        tags,
        arn: db.DBInstanceArn ?? null,
        consoleId: db.DBInstanceIdentifier,
        securityGroupIds: (db.VpcSecurityGroups ?? [])
          .map((sg) => sg.VpcSecurityGroupId)
          .filter((id): id is string => typeof id === 'string'),
        logGroups: (db.EnabledCloudwatchLogsExports ?? []).map(
          (kind) => `/aws/rds/instance/${db.DBInstanceIdentifier}/${kind}`,
        ),
        raw: db,
        props: props([
          prop('Engine', `${db.Engine ?? ''} ${db.EngineVersion ?? ''}`.trim()),
          prop('Instance class', db.DBInstanceClass),
          prop('Storage', `${db.AllocatedStorage ?? '?'} GiB ${db.StorageType ?? ''}`.trim()),
          prop('Multi-AZ', db.MultiAZ ? `enabled (${db.SecondaryAvailabilityZone ?? ''})`.trim() : 'disabled'),
          prop('Endpoint', db.Endpoint?.Address),
          prop('Port', db.Endpoint?.Port),
          prop('Availability zone', db.AvailabilityZone),
          prop('Replica of', db.ReadReplicaSourceDBInstanceIdentifier),
          prop('Performance Insights', db.PerformanceInsightsEnabled ? 'enabled' : 'disabled'),
          prop('Log exports', (db.EnabledCloudwatchLogsExports ?? []).join(', ') || 'none'),
          prop(
            POSTURE_FACTS.storageEncryption.key,
            db.StorageEncrypted
              ? `KMS ${db.KmsKeyId ?? ''}`.trim()
              : POSTURE_FACTS.storageEncryption.absent,
          ),
          prop(
            POSTURE_FACTS.publiclyAccessible.key,
            db.PubliclyAccessible ? POSTURE_FACTS.publiclyAccessible.yes : POSTURE_FACTS.publiclyAccessible.no,
          ),
          prop('Parameter group', db.DBParameterGroups?.[0]?.DBParameterGroupName),
        ]),
      }),
    )
  }

  // --- ElastiCache -------------------------------------------------------
  const sgVpc = new Map(data.securityGroups.map((sg) => [sg.GroupId ?? '', sg.VpcId]))
  for (const cluster of data.cacheClusters) {
    if (!cluster.CacheClusterId) continue
    const tags = toTags(cluster.ARN ? data.cacheClusterTags[cluster.ARN] : undefined)
    // ElastiCache does not return a VPC id; derive it from a security group.
    const vpcId = (cluster.SecurityGroups ?? [])
      .map((sg) => (sg.SecurityGroupId ? sgVpc.get(sg.SecurityGroupId) : undefined))
      .find((id): id is string => typeof id === 'string')
    const az = cluster.PreferredAvailabilityZone ?? cluster.CacheNodes?.[0]?.CustomerAvailabilityZone
    const place = placement(vpcId, undefined, az)

    nodes.push(
      node({
        id: cluster.CacheClusterId,
        type: 'elasticache',
        category: 'database',
        name: cluster.CacheClusterId,
        abbr: 'EC$',
        subtitle: cluster.CacheNodeType,
        typeLabel: `ElastiCache ${cluster.Engine ?? ''} node`.replace('  ', ' '),
        region,
        ...place,
        state: cluster.CacheClusterStatus ?? 'unknown',
        tags,
        arn: cluster.ARN ?? null,
        consoleId: cluster.CacheClusterId,
        securityGroupIds: (cluster.SecurityGroups ?? [])
          .map((sg) => sg.SecurityGroupId)
          .filter((id): id is string => typeof id === 'string'),
        raw: cluster,
        props: props([
          prop('Engine', `${cluster.Engine ?? ''} ${cluster.EngineVersion ?? ''}`.trim()),
          prop('Node type', cluster.CacheNodeType),
          prop('Nodes', cluster.NumCacheNodes),
          prop('Endpoint', cluster.ConfigurationEndpoint?.Address),
          prop('Availability zone', az),
          prop('Replication group', cluster.ReplicationGroupId),
          prop('Encryption in transit', cluster.TransitEncryptionEnabled ? 'enabled' : 'disabled'),
          prop('Encryption at rest', cluster.AtRestEncryptionEnabled ? 'enabled' : 'disabled'),
        ]),
      }),
    )
  }

  // --- ECS tasks ---------------------------------------------------------
  const clusterNameByArn = new Map(
    data.ecsClusters.map((c) => [c.clusterArn ?? '', c.clusterName ?? '']),
  )
  for (const task of data.ecsTasks) {
    if (!task.taskArn) continue
    const eni = task.attachments
      ?.flatMap((attachment) => attachment.details ?? [])
      .reduce<Record<string, string>>((acc, detail) => {
        if (detail.name && detail.value) acc[detail.name] = detail.value
        return acc
      }, {})
    const subnetId = eni?.subnetId
    const privateIp = eni?.privateIPv4Address
    const place = placement(undefined, subnetId, task.availabilityZone)
    const clusterName = clusterNameByArn.get(task.clusterArn ?? '') ?? ''
    const definition = task.taskDefinitionArn
      ? data.taskDefinitions[task.taskDefinitionArn]
      : undefined
    const logGroups = (definition?.containerDefinitions ?? [])
      .map((container) => container.logConfiguration?.options?.['awslogs-group'])
      .filter((group): group is string => typeof group === 'string')

    const shortId = lastSegment(task.taskArn)
    nodes.push(
      node({
        id: task.taskArn,
        type: 'ecs-task',
        category: 'compute',
        name: `${lastSegment(task.taskDefinitionArn ?? 'task').split(':')[0] ?? 'task'}/${shortId.slice(0, 6)}`,
        abbr: 'ECS',
        subtitle: privateIp,
        typeLabel: `ECS ${task.launchType ?? ''} task`.replace('  ', ' '),
        region,
        ...place,
        state: task.lastStatus ?? 'unknown',
        tags: toTags(task.tags),
        arn: task.taskArn,
        consoleId: shortId,
        consoleExtra: { cluster: clusterName },
        securityGroupIds: [],
        logGroups: [...new Set(logGroups)],
        raw: task,
        props: props([
          prop('Task ID', shortId),
          prop('Cluster', clusterName),
          // ECS publishes metrics per service, not per task. `group` is
          // "service:<name>" for a service-managed task, and without it the
          // Metrics tab has no dimensions to query with.
          prop('Service', serviceNameOf(task.group)),
          prop('Task definition', lastSegment(task.taskDefinitionArn ?? '')),
          prop('Launch type', task.launchType),
          prop('CPU / memory', `${task.cpu ?? '?'} / ${task.memory ?? '?'}`),
          prop('Private IPv4', privateIp),
          prop('Subnet', subnetId),
          prop('Availability zone', task.availabilityZone),
          prop('Health', task.healthStatus),
          prop('Started', task.startedAt ? new Date(task.startedAt).toISOString() : undefined),
          prop('Log groups', [...new Set(logGroups)].join(', ') || 'none'),
        ]),
      }),
    )
  }

  // Regional services sit in the lane (or in a subnet, when VPC-attached), so
  // they are built before the lane node decides whether it is needed.
  const serviceNodes = [
    ...buildRegionalServiceNodes(data, region, accountId),
    ...buildWebAclNodes(data, 'REGIONAL'),
    ...(global ? buildBucketNodes(global, region) : []),
  ]
  nodes.push(...serviceNodes)
  const laneOccupied =
    needsLane || serviceNodes.some((candidate) => candidate.parentId === laneId(region))

  if (laneOccupied) {
    nodes.push(
      node({
        id: laneId(region),
        type: 'lane',
        category: 'network',
        name: 'Regional services',
        abbr: 'G',
        typeLabel: 'Service lane',
        region,
        parentId: regionId(region),
        state: 'active',
        raw: {},
      }),
    )
  }
  // --- edges -------------------------------------------------------------
  edges.push(...buildLoadBalancerEdges(data))
  edges.push(...buildRdsEdges(data))
  edges.push(...buildElastiCacheEdges(data))

  const nodeIds = new Set(nodes.map((n) => n.id))
  const resolved = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))

  const alarms = data.alarms
    .map((alarm) => mapAlarm(alarm, region, nodes))
    .filter((alarm): alarm is Alarm => alarm !== null)

  const resourceCount = nodes.filter(
    (n) => !['region', 'vpc', 'az', 'subnet', 'lane'].includes(n.type),
  ).length

  return { nodes, edges: resolved, securityGroups, alarms, resourceCount }
}

// ---------------------------------------------------------------------------
// Edge builders
// ---------------------------------------------------------------------------

/**
 * Listener → target group → targets. Instance targets resolve directly; IP
 * targets are matched back to an ECS task through its attached ENI, which is
 * the only way Fargate tasks connect to their load balancer.
 */
function buildLoadBalancerEdges(data: RegionScanData): GraphEdge[] {
  const edges: GraphEdge[] = []

  const taskByPrivateIp = new Map<string, string>()
  for (const task of data.ecsTasks) {
    if (!task.taskArn) continue
    for (const attachment of task.attachments ?? []) {
      for (const detail of attachment.details ?? []) {
        if (detail.name === 'privateIPv4Address' && detail.value) {
          taskByPrivateIp.set(detail.value, task.taskArn)
        }
      }
    }
  }

  // An ENI's private IP also identifies non-ECS IP targets.
  const eniByPrivateIp = new Map<string, string>()
  for (const eni of data.networkInterfaces) {
    if (eni.PrivateIpAddress && eni.Attachment?.InstanceId) {
      eniByPrivateIp.set(eni.PrivateIpAddress, eni.Attachment.InstanceId)
    }
  }

  for (const tg of data.targetGroups) {
    if (!tg.TargetGroupArn) continue
    const health = data.targetHealth[tg.TargetGroupArn] ?? []
    for (const lbArn of tg.LoadBalancerArns ?? []) {
      for (const target of health) {
        const id = target.Target?.Id
        if (!id) continue
        const targetNodeId = id.startsWith('i-')
          ? id
          : (taskByPrivateIp.get(id) ?? eniByPrivateIp.get(id))
        if (!targetNodeId) continue

        const port = target.Target?.Port ?? tg.Port
        edges.push({
          id: `traffic:${lbArn}->${targetNodeId}:${port ?? ''}`,
          source: lbArn,
          target: targetNodeId,
          kind: 'traffic',
          label: port ? String(port) : undefined,
          meta: {
            via: tg.TargetGroupName ?? lastSegment(tg.TargetGroupArn),
            health: target.TargetHealth?.State ?? 'unknown',
          },
        })
      }
    }
  }

  return edges
}

/** Primary → read replica, and cluster membership. */
function buildRdsEdges(data: RegionScanData): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const db of data.dbInstances) {
    if (!db.DBInstanceIdentifier) continue
    const source = db.ReadReplicaSourceDBInstanceIdentifier
    if (source) {
      edges.push({
        id: `traffic:${source}->${db.DBInstanceIdentifier}:replication`,
        source,
        target: db.DBInstanceIdentifier,
        kind: 'traffic',
        label: String(db.Endpoint?.Port ?? 5432),
        meta: { via: 'read replica' },
      })
    }
  }
  return edges
}

/** Redis replication group primary → replicas. */
function buildElastiCacheEdges(data: RegionScanData): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const group of data.replicationGroups) {
    for (const nodeGroup of group.NodeGroups ?? []) {
      const primary = nodeGroup.NodeGroupMembers?.find((m) => m.CurrentRole === 'primary')
      if (!primary?.CacheClusterId) continue
      for (const member of nodeGroup.NodeGroupMembers ?? []) {
        if (!member.CacheClusterId || member.CacheClusterId === primary.CacheClusterId) continue
        edges.push({
          id: `traffic:${primary.CacheClusterId}->${member.CacheClusterId}:replication`,
          source: primary.CacheClusterId,
          target: member.CacheClusterId,
          kind: 'traffic',
          label: '6379',
          meta: { via: 'replication' },
        })
      }
    }
  }
  return edges
}

// ---------------------------------------------------------------------------
// Security group rule flattening
// ---------------------------------------------------------------------------

interface IpPermission {
  IpProtocol?: string
  FromPort?: number
  ToPort?: number
  IpRanges?: Array<{ CidrIp?: string; Description?: string }>
  Ipv6Ranges?: Array<{ CidrIpv6?: string; Description?: string }>
  UserIdGroupPairs?: Array<{ GroupId?: string; Description?: string }>
  PrefixListIds?: Array<{ PrefixListId?: string; Description?: string }>
}

/** One AWS IpPermission fans out into one rule per source. */
export function flattenRule(
  permission: IpPermission,
  direction: 'in' | 'out',
): SecurityGroupRule[] {
  const protocol = permission.IpProtocol ?? '-1'
  const allPorts = protocol === '-1' || permission.FromPort === undefined
  const fromPort = allPorts ? null : (permission.FromPort ?? null)
  const toPort = allPorts ? null : (permission.ToPort ?? permission.FromPort ?? null)
  const port = allPorts
    ? 'all'
    : fromPort === toPort
      ? String(fromPort)
      : `${fromPort}-${toPort}`

  const base = { direction, protocol, port, fromPort, toPort }

  return [
    ...(permission.IpRanges ?? []).map((range) => ({
      ...base,
      source: range.CidrIp ?? '',
      description: range.Description,
    })),
    ...(permission.Ipv6Ranges ?? []).map((range) => ({
      ...base,
      source: range.CidrIpv6 ?? '',
      description: range.Description,
    })),
    ...(permission.UserIdGroupPairs ?? []).map((pair) => ({
      ...base,
      source: pair.GroupId ?? '',
      description: pair.Description,
    })),
    ...(permission.PrefixListIds ?? []).map((pl) => ({
      ...base,
      source: pl.PrefixListId ?? '',
      description: pl.Description,
    })),
  ].filter((rule) => rule.source !== '')
}

// ---------------------------------------------------------------------------
// Alarm mapping
// ---------------------------------------------------------------------------

/** Dimension name that identifies the node, per namespace. */
const ALARM_DIMENSION: Record<string, string> = {
  'AWS/EC2': 'InstanceId',
  'AWS/RDS': 'DBInstanceIdentifier',
  'AWS/ElastiCache': 'CacheClusterId',
  'AWS/ApplicationELB': 'LoadBalancer',
  'AWS/NetworkELB': 'LoadBalancer',
  'AWS/ECS': 'ServiceName',
}

export function mapAlarm(alarm: MetricAlarm, region: string, nodes: GraphNode[]): Alarm | null {
  if (!alarm.AlarmName) return null
  const dimensionName = alarm.Namespace ? ALARM_DIMENSION[alarm.Namespace] : undefined
  const value = alarm.Dimensions?.find((d) => d.Name === dimensionName)?.Value

  let nodeId: string | null = null
  if (value) {
    // LoadBalancer dimensions look like "app/my-alb/50dc6c495c0c9188"; the ALB
    // node is keyed by ARN, whose tail is the same string.
    const match = nodes.find((n) => n.id === value || n.id.endsWith(`/${value}`) || n.name === value)
    nodeId = match?.id ?? null
  }

  return {
    name: alarm.AlarmName,
    arn: alarm.AlarmArn ?? null,
    state: (alarm.StateValue ?? 'INSUFFICIENT_DATA') as Alarm['state'],
    reason: alarm.StateReason ?? '',
    updatedAt: alarm.StateUpdatedTimestamp
      ? new Date(alarm.StateUpdatedTimestamp).getTime()
      : Date.now(),
    metricName: alarm.MetricName ?? null,
    namespace: alarm.Namespace ?? null,
    nodeId,
    region,
    threshold: alarm.Threshold ?? null,
    comparisonOperator: alarm.ComparisonOperator ?? null,
  }
}
