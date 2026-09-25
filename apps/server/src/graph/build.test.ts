import { describe, expect, it } from 'vitest'
import { emptyRegionScanData, type RegionScanData } from '../collectors/types.js'
import { buildRegionGraph, flattenRule, isPublicSubnet, mapAlarm } from './build.js'

const ACCOUNT = '111122223333'
const REGION = 'us-east-1'

function data(patch: Partial<RegionScanData> = {}): RegionScanData {
  return { ...emptyRegionScanData(REGION), ...patch }
}

const vpc = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', State: 'available' as const }

function subnet(id: string, az: string, cidr: string) {
  return {
    SubnetId: id,
    VpcId: 'vpc-1',
    AvailabilityZone: az,
    CidrBlock: cidr,
    State: 'available' as const,
  }
}

describe('isPublicSubnet', () => {
  const pub = subnet('subnet-pub', 'us-east-1a', '10.0.1.0/24')
  const priv = subnet('subnet-priv', 'us-east-1a', '10.0.11.0/24')

  it('is public when its own route table routes 0.0.0.0/0 to an igw', () => {
    const tables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-pub' }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }],
      },
    ]
    expect(isPublicSubnet(pub, tables)).toBe(true)
  })

  it('is private when the default route goes to a NAT gateway', () => {
    const tables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-priv' }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }],
      },
    ]
    expect(isPublicSubnet(priv, tables)).toBe(false)
  })

  it('falls back to the VPC main route table when there is no explicit association', () => {
    const tables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }],
      },
    ]
    // This is the case a naive implementation gets wrong: no association row
    // for the subnet, so it inherits the main table and is in fact public.
    expect(isPublicSubnet(pub, tables)).toBe(true)
  })

  it('prefers an explicit association over the main table', () => {
    const tables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }],
      },
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-priv' }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }],
      },
    ]
    expect(isPublicSubnet(priv, tables)).toBe(false)
  })

  it('is private when no route table matches at all', () => {
    expect(isPublicSubnet(priv, [])).toBe(false)
  })

  it('ignores a local-only route table', () => {
    const tables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-priv' }],
        Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }],
      },
    ]
    expect(isPublicSubnet(priv, tables)).toBe(false)
  })
})

describe('containment', () => {
  it('nests region > vpc > az > subnet > resource', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        subnets: [subnet('subnet-a', 'us-east-1a', '10.0.1.0/24')],
        instances: [
          {
            InstanceId: 'i-1',
            VpcId: 'vpc-1',
            SubnetId: 'subnet-a',
            InstanceType: 't3.large',
            State: { Name: 'running' },
            Placement: { AvailabilityZone: 'us-east-1a' },
          },
        ],
      }),
      ACCOUNT,
    )

    const byId = new Map(built.nodes.map((n) => [n.id, n]))
    expect(byId.get('i-1')?.parentId).toBe('subnet-a')
    expect(byId.get('subnet-a')?.parentId).toBe('az:vpc-1:us-east-1a')
    expect(byId.get('az:vpc-1:us-east-1a')?.parentId).toBe('vpc-1')
    expect(byId.get('vpc-1')?.parentId).toBe('region:us-east-1')
    expect(byId.get('region:us-east-1')?.parentId).toBeNull()
  })

  it('falls back to the VPC when the subnet is unknown', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        instances: [
          {
            InstanceId: 'i-1',
            VpcId: 'vpc-1',
            SubnetId: 'subnet-missing',
            State: { Name: 'running' },
          },
        ],
      }),
      ACCOUNT,
    )
    expect(built.nodes.find((n) => n.id === 'i-1')?.parentId).toBe('vpc-1')
  })

  it('counts only non-container nodes as resources', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        subnets: [subnet('subnet-a', 'us-east-1a', '10.0.1.0/24')],
        instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', SubnetId: 'subnet-a', State: { Name: 'running' } }],
      }),
      ACCOUNT,
    )
    expect(built.resourceCount).toBe(1)
  })
})

describe('load balancer edges', () => {
  const base = {
    vpcs: [vpc],
    subnets: [subnet('subnet-a', 'us-east-1a', '10.0.1.0/24')],
    loadBalancers: [
      {
        LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/alb/1',
        LoadBalancerName: 'alb',
        VpcId: 'vpc-1',
        Type: 'application' as const,
        Scheme: 'internet-facing' as const,
        AvailabilityZones: [{ ZoneName: 'us-east-1a', SubnetId: 'subnet-a' }],
      },
    ],
    targetGroups: [
      {
        TargetGroupArn: 'arn:tg:1',
        TargetGroupName: 'tg-api',
        Port: 8080,
        LoadBalancerArns: [
          'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/alb/1',
        ],
      },
    ],
  }

  it('connects an ALB to an instance target', () => {
    const built = buildRegionGraph(
      data({
        ...base,
        instances: [
          { InstanceId: 'i-1', VpcId: 'vpc-1', SubnetId: 'subnet-a', State: { Name: 'running' } },
        ],
        targetHealth: {
          'arn:tg:1': [{ Target: { Id: 'i-1', Port: 8080 }, TargetHealth: { State: 'healthy' } }],
        },
      }),
      ACCOUNT,
    )
    const edge = built.edges.find((e) => e.target === 'i-1')
    expect(edge?.kind).toBe('traffic')
    expect(edge?.label).toBe('8080')
    expect(edge?.meta.health).toBe('healthy')
  })

  it('resolves an IP target back to the ECS task that owns the ENI', () => {
    const built = buildRegionGraph(
      data({
        ...base,
        ecsClusters: [{ clusterArn: 'arn:cluster:prod', clusterName: 'prod' }],
        ecsTasks: [
          {
            taskArn: 'arn:task:abc123',
            clusterArn: 'arn:cluster:prod',
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:111122223333:task-definition/api:7',
            lastStatus: 'RUNNING',
            launchType: 'FARGATE',
            attachments: [
              {
                details: [
                  { name: 'subnetId', value: 'subnet-a' },
                  { name: 'privateIPv4Address', value: '10.0.1.55' },
                ],
              },
            ],
          },
        ],
        targetHealth: {
          'arn:tg:1': [
            { Target: { Id: '10.0.1.55', Port: 8080 }, TargetHealth: { State: 'healthy' } },
          ],
        },
      }),
      ACCOUNT,
    )
    // This is the Fargate path: the target is an IP, not an instance id.
    const edge = built.edges.find((e) => e.target === 'arn:task:abc123')
    expect(edge).toBeDefined()
    expect(edge?.source).toContain('loadbalancer/app/alb/1')
  })

  it('resolves an IP target to an instance through its ENI', () => {
    const built = buildRegionGraph(
      data({
        ...base,
        instances: [
          { InstanceId: 'i-9', VpcId: 'vpc-1', SubnetId: 'subnet-a', State: { Name: 'running' } },
        ],
        networkInterfaces: [
          { PrivateIpAddress: '10.0.1.77', Attachment: { InstanceId: 'i-9' } },
        ],
        targetHealth: {
          'arn:tg:1': [{ Target: { Id: '10.0.1.77' }, TargetHealth: { State: 'healthy' } }],
        },
      }),
      ACCOUNT,
    )
    expect(built.edges.some((e) => e.target === 'i-9')).toBe(true)
  })

  it('drops an edge whose target never resolved', () => {
    const built = buildRegionGraph(
      data({
        ...base,
        targetHealth: {
          'arn:tg:1': [{ Target: { Id: '10.9.9.9' }, TargetHealth: { State: 'unused' } }],
        },
      }),
      ACCOUNT,
    )
    expect(built.edges).toHaveLength(0)
  })
})

describe('database edges', () => {
  it('links an RDS primary to its read replica', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        dbInstances: [
          {
            DBInstanceIdentifier: 'primary',
            DBInstanceStatus: 'available',
            DBSubnetGroup: { VpcId: 'vpc-1' },
          },
          {
            DBInstanceIdentifier: 'replica',
            DBInstanceStatus: 'available',
            ReadReplicaSourceDBInstanceIdentifier: 'primary',
            DBSubnetGroup: { VpcId: 'vpc-1' },
            Endpoint: { Port: 5432 },
          },
        ],
      }),
      ACCOUNT,
    )
    const edge = built.edges.find((e) => e.source === 'primary' && e.target === 'replica')
    expect(edge?.label).toBe('5432')
    expect(edge?.meta.via).toBe('read replica')
  })

  it('links an ElastiCache primary to its replicas', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        securityGroups: [{ GroupId: 'sg-1', GroupName: 'cache', VpcId: 'vpc-1' }],
        cacheClusters: [
          { CacheClusterId: 'cache-001', SecurityGroups: [{ SecurityGroupId: 'sg-1' }] },
          { CacheClusterId: 'cache-002', SecurityGroups: [{ SecurityGroupId: 'sg-1' }] },
        ],
        replicationGroups: [
          {
            ReplicationGroupId: 'rg',
            NodeGroups: [
              {
                NodeGroupMembers: [
                  { CacheClusterId: 'cache-001', CurrentRole: 'primary' },
                  { CacheClusterId: 'cache-002', CurrentRole: 'replica' },
                ],
              },
            ],
          },
        ],
      }),
      ACCOUNT,
    )
    expect(built.edges.some((e) => e.source === 'cache-001' && e.target === 'cache-002')).toBe(true)
  })

  it('derives an ElastiCache VPC from its security group', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        securityGroups: [{ GroupId: 'sg-1', GroupName: 'cache', VpcId: 'vpc-1' }],
        cacheClusters: [
          {
            CacheClusterId: 'cache-001',
            SecurityGroups: [{ SecurityGroupId: 'sg-1' }],
            PreferredAvailabilityZone: 'us-east-1a',
          },
        ],
        subnets: [subnet('subnet-a', 'us-east-1a', '10.0.1.0/24')],
      }),
      ACCOUNT,
    )
    // ElastiCache returns no VpcId, so without this the node would float free.
    const node = built.nodes.find((n) => n.id === 'cache-001')
    expect(node?.vpcId).toBe('vpc-1')
    expect(node?.parentId).toBe('az:vpc-1:us-east-1a')
  })
})

describe('flattenRule', () => {
  it('fans one permission out into a rule per source', () => {
    const rules = flattenRule(
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }, { CidrIp: '10.0.0.0/8' }],
        UserIdGroupPairs: [{ GroupId: 'sg-abc' }],
      },
      'in',
    )
    expect(rules).toHaveLength(3)
    expect(rules.map((r) => r.source)).toEqual(['0.0.0.0/0', '10.0.0.0/8', 'sg-abc'])
    expect(rules.every((r) => r.port === '443')).toBe(true)
  })

  it('represents an all-traffic rule with null bounds', () => {
    const [rule] = flattenRule({ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }, 'out')
    expect(rule?.port).toBe('all')
    expect(rule?.fromPort).toBeNull()
    expect(rule?.toPort).toBeNull()
  })

  it('renders a port range', () => {
    const [rule] = flattenRule(
      { IpProtocol: 'tcp', FromPort: 1024, ToPort: 65535, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
      'in',
    )
    expect(rule?.port).toBe('1024-65535')
  })

  it('keeps IPv6 sources', () => {
    const [rule] = flattenRule(
      { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, Ipv6Ranges: [{ CidrIpv6: '::/0' }] },
      'in',
    )
    expect(rule?.source).toBe('::/0')
  })

  it('drops a permission with no sources at all', () => {
    expect(flattenRule({ IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }, 'in')).toEqual([])
  })
})

describe('mapAlarm', () => {
  const nodes = buildRegionGraph(
    data({
      vpcs: [vpc],
      instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', State: { Name: 'running' } }],
      loadBalancers: [
        {
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/api-alb/50dc6c49',
          LoadBalancerName: 'api-alb',
          VpcId: 'vpc-1',
          Type: 'application',
        },
      ],
    }),
    ACCOUNT,
  ).nodes

  it('maps an EC2 alarm by InstanceId', () => {
    const alarm = mapAlarm(
      {
        AlarmName: 'cpu-high',
        Namespace: 'AWS/EC2',
        MetricName: 'CPUUtilization',
        StateValue: 'ALARM',
        Dimensions: [{ Name: 'InstanceId', Value: 'i-1' }],
      },
      REGION,
      nodes,
    )
    expect(alarm?.nodeId).toBe('i-1')
    expect(alarm?.state).toBe('ALARM')
  })

  it('maps an ALB alarm whose dimension is the ARN tail', () => {
    const alarm = mapAlarm(
      {
        AlarmName: 'alb-5xx',
        Namespace: 'AWS/ApplicationELB',
        StateValue: 'OK',
        Dimensions: [{ Name: 'LoadBalancer', Value: 'app/api-alb/50dc6c49' }],
      },
      REGION,
      nodes,
    )
    expect(alarm?.nodeId).toContain('loadbalancer/app/api-alb/50dc6c49')
  })

  it('still returns an alarm when no node matches', () => {
    const alarm = mapAlarm(
      {
        AlarmName: 'orphan',
        Namespace: 'AWS/SQS',
        StateValue: 'OK',
        Dimensions: [{ Name: 'QueueName', Value: 'gone' }],
      },
      REGION,
      nodes,
    )
    expect(alarm).not.toBeNull()
    expect(alarm?.nodeId).toBeNull()
  })

  it('defaults a missing state to INSUFFICIENT_DATA', () => {
    expect(mapAlarm({ AlarmName: 'a' }, REGION, nodes)?.state).toBe('INSUFFICIENT_DATA')
  })
})

describe('resource detail', () => {
  it('flags IMDSv1 and public accessibility for later posture findings', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        instances: [
          {
            InstanceId: 'i-1',
            VpcId: 'vpc-1',
            State: { Name: 'running' },
            MetadataOptions: { HttpTokens: 'optional' },
          },
        ],
        dbInstances: [
          {
            DBInstanceIdentifier: 'db',
            DBInstanceStatus: 'available',
            PubliclyAccessible: true,
            DBSubnetGroup: { VpcId: 'vpc-1' },
          },
        ],
      }),
      ACCOUNT,
    )
    const instance = built.nodes.find((n) => n.id === 'i-1')
    expect(instance?.props.find((p) => p.k === 'IMDS')?.v).toBe('v1 and v2 allowed')
    const db = built.nodes.find((n) => n.id === 'db')
    expect(db?.props.find((p) => p.k === 'Publicly accessible')?.v).toBe('YES')
  })

  it('derives RDS log groups from the enabled exports', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        dbInstances: [
          {
            DBInstanceIdentifier: 'prod-pg',
            DBInstanceStatus: 'available',
            EnabledCloudwatchLogsExports: ['postgresql', 'upgrade'],
            DBSubnetGroup: { VpcId: 'vpc-1' },
          },
        ],
      }),
      ACCOUNT,
    )
    expect(built.nodes.find((n) => n.id === 'prod-pg')?.logGroups).toEqual([
      '/aws/rds/instance/prod-pg/postgresql',
      '/aws/rds/instance/prod-pg/upgrade',
    ])
  })

  it('reads the awslogs group out of the task definition', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        ecsClusters: [{ clusterArn: 'arn:cluster:prod', clusterName: 'prod' }],
        ecsTasks: [
          {
            taskArn: 'arn:task:1',
            clusterArn: 'arn:cluster:prod',
            taskDefinitionArn: 'arn:td:api:7',
            lastStatus: 'RUNNING',
          },
        ],
        taskDefinitions: {
          'arn:td:api:7': {
            containerDefinitions: [
              {
                name: 'api',
                logConfiguration: {
                  logDriver: 'awslogs',
                  options: { 'awslogs-group': '/ecs/cortex-api' },
                },
              },
            ],
          },
        },
      }),
      ACCOUNT,
    )
    expect(built.nodes.find((n) => n.id === 'arn:task:1')?.logGroups).toEqual(['/ecs/cortex-api'])
  })

  it('prefers the Name tag for display', () => {
    const built = buildRegionGraph(
      data({
        vpcs: [vpc],
        instances: [
          {
            InstanceId: 'i-1',
            VpcId: 'vpc-1',
            State: { Name: 'running' },
            Tags: [{ Key: 'Name', Value: 'legacy-worker' }],
          },
        ],
      }),
      ACCOUNT,
    )
    expect(built.nodes.find((n) => n.id === 'i-1')?.name).toBe('legacy-worker')
  })
})
