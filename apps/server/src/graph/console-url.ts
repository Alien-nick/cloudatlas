import type { NodeType } from '@cloudatlas/shared'

const BASE = 'https://console.aws.amazon.com'

/**
 * Build the AWS console deep link for a resource. `resourceId` is the
 * service-native identifier (instance id, bucket name, function name, ...),
 * not the ARN — each console uses a different one.
 */
export function buildConsoleUrl(
  type: NodeType,
  region: string,
  resourceId: string,
  extra: { cluster?: string; webAclScope?: 'global' | 'regional'; webAclId?: string } = {},
): string | null {
  const r = encodeURIComponent(region)
  const id = encodeURIComponent(resourceId)

  switch (type) {
    case 'ec2':
      return `${BASE}/ec2/home?region=${r}#InstanceDetails:instanceId=${id}`
    case 'ebs-volume':
      return `${BASE}/ec2/home?region=${r}#VolumeDetails:volumeId=${id}`
    case 'alb':
    case 'nlb':
      return `${BASE}/ec2/home?region=${r}#LoadBalancers:search=${id}`
    case 'target-group':
      return `${BASE}/ec2/home?region=${r}#TargetGroups:search=${id}`
    case 'security-group':
      return `${BASE}/ec2/home?region=${r}#SecurityGroup:groupId=${id}`
    case 'nat-gateway':
      return `${BASE}/vpcconsole/home?region=${r}#NatGatewayDetails:natGatewayId=${id}`
    case 'internet-gateway':
      return `${BASE}/vpcconsole/home?region=${r}#InternetGateway:internetGatewayId=${id}`
    case 'eni':
      return `${BASE}/ec2/home?region=${r}#NetworkInterface:networkInterfaceId=${id}`
    case 'vpc-endpoint':
      return `${BASE}/vpcconsole/home?region=${r}#Endpoints:vpcEndpointId=${id}`
    case 'vpc':
      return `${BASE}/vpcconsole/home?region=${r}#VpcDetails:VpcId=${id}`
    case 'subnet':
      return `${BASE}/vpcconsole/home?region=${r}#SubnetDetails:subnetId=${id}`
    case 'rds':
      return `${BASE}/rds/home?region=${r}#database:id=${id};is-cluster=false`
    case 'rds-cluster':
      return `${BASE}/rds/home?region=${r}#database:id=${id};is-cluster=true`
    case 'elasticache':
      return `${BASE}/elasticache/home?region=${r}#/redis/${id}`
    case 's3':
      // S3 is global in the console but wants the region as a hint.
      return `https://s3.console.aws.amazon.com/s3/buckets/${id}?region=${r}`
    case 'lambda':
      return `${BASE}/lambda/home?region=${r}#/functions/${id}`
    case 'sqs':
      return `${BASE}/sqs/v3/home?region=${r}#/queues/${id}`
    case 'sns':
      return `${BASE}/sns/v3/home?region=${r}#/topic/${id}`
    case 'eventbridge-rule':
      return `${BASE}/events/home?region=${r}#/rules/${id}`
    case 'ecs-task':
      return extra.cluster
        ? `${BASE}/ecs/v2/clusters/${encodeURIComponent(extra.cluster)}/tasks/${id}?region=${r}`
        : `${BASE}/ecs/v2/clusters?region=${r}`
    case 'ecs-service':
      return extra.cluster
        ? `${BASE}/ecs/v2/clusters/${encodeURIComponent(extra.cluster)}/services/${id}?region=${r}`
        : `${BASE}/ecs/v2/clusters?region=${r}`
    case 'cloudfront':
      return `${BASE}/cloudfront/v4/home#/distributions/${id}`
    case 'route53-zone':
      return `${BASE}/route53/v2/hostedzones#ListRecordSets/${id}`
    case 'waf-web-acl': {
      const scope = extra.webAclScope === 'regional' ? r : 'global'
      const aclId = extra.webAclId ? encodeURIComponent(extra.webAclId) : id
      return `${BASE}/wafv2/homev2/web-acl/${id}/${aclId}/overview?region=${scope}`
    }
    case 'network-firewall':
      return `${BASE}/vpcconsole/home?region=${r}#FirewallDetails:firewallName=${id}`
    case 'iam-role':
      return `${BASE}/iam/home#/roles/${id}`
    case 'region':
    case 'az':
    case 'lane':
    case 'internet':
      return null
    default:
      return null
  }
}
