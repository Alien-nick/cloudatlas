import type { Fix, GraphNode, SecurityGroupRule } from '@cloudatlas/shared'
import { WORLD_CIDRS } from '@cloudatlas/shared'
import type { CheckContext } from './checks.js'
import { awsCli, fact, instanceId, q, rdsTarget, regionOf, withInputFlag } from '../aws/cli-command.js'

/**
 * Copy-paste fixes: AWS CLI commands for one failing resource.
 *
 * These are strings. Nothing here calls AWS, and nothing may — CloudAtlas is
 * read-only by construction, and a fix is something the user reviews and runs
 * in their own shell, under their own credentials, when they decide to.
 *
 * Every command names the exact resource, region and profile, so the common
 * case is one paste. Where a fix needs a value only the user knows (the bucket
 * flow logs should go to, the web ACL to attach) the command keeps a visible
 * `<placeholder>` and the fix is marked `needsInput`, rather than guessing a
 * value that would run successfully and do the wrong thing.
 *
 * Fixes that cannot be done in place (encrypting an existing RDS instance or
 * EBS volume) are given as the documented migration steps, with a caution
 * that says so. Checks with no sensible command-line fix return null.
 */

export interface FixContext extends CheckContext {
  profile: string
  accountId: string
}

type FixBuilder = (node: GraphNode, context: FixContext) => Omit<Fix, 'needsInput'> | null

const aws = awsCli

/** CloudWatch log types each engine can export; order is what the console shows. */
function logTypesFor(engine: string | undefined): string[] | null {
  const name = (engine ?? '').toLowerCase()
  if (name.includes('aurora-postgres') || name.includes('postgres')) return ['postgresql', 'upgrade']
  if (name.includes('aurora-mysql') || name.includes('aurora')) return ['audit', 'error', 'general', 'slowquery']
  if (name.includes('mysql') || name.includes('mariadb')) return ['error', 'general', 'slowquery']
  if (name.includes('oracle')) return ['alert', 'audit', 'listener', 'trace']
  if (name.includes('sqlserver')) return ['agent', 'error']
  return null
}

function ipPermission(rule: SecurityGroupRule): Record<string, unknown> {
  const permission: Record<string, unknown> = { IpProtocol: rule.protocol === 'all' ? '-1' : rule.protocol }
  if (rule.fromPort !== null) permission.FromPort = rule.fromPort
  if (rule.toPort !== null) permission.ToPort = rule.toPort
  if (rule.source === '::/0') permission.Ipv6Ranges = [{ CidrIpv6: rule.source }]
  else permission.IpRanges = [{ CidrIp: rule.source }]
  return permission
}

const BUILDERS: Record<string, FixBuilder> = {
  'sg-no-world-admin-ports': (node, context) => {
    const commands: string[] = []
    for (const sgId of node.securityGroupIds) {
      const sg = context.sgById.get(sgId)
      for (const rule of sg?.rules ?? []) {
        if (!rule.risky || rule.direction !== 'in' || !WORLD_CIDRS.includes(rule.source)) continue
        commands.push(
          aws(
            node,
            context,
            `ec2 revoke-security-group-ingress --group-id ${q(sgId)} --ip-permissions ${q(JSON.stringify([ipPermission(rule)]))}`,
          ),
        )
      }
    }
    if (commands.length === 0) return null
    return {
      commands,
      caution:
        'Removes the rule for everyone who relies on it, including anything else attached to the ' +
        'same security group. If the port is still needed, add a narrower rule (your office CIDR, ' +
        'a bastion security group) first — or use Session Manager instead of SSH/RDP.',
    }
  },

  'rds-not-public': (node, context) => ({
    commands: [aws(node, context, `rds ${rdsTarget(node)} --no-publicly-accessible --apply-immediately`)],
    caution: 'Clients connecting over the public endpoint lose access immediately; confirm none do.',
  }),

  'data-tier-private-subnet': (node, context) =>
    node.type === 'elasticache'
      ? null
      : {
          commands: [
            aws(
              node,
              context,
              `rds create-db-subnet-group --db-subnet-group-name ${q(`${node.name}-private`)} ` +
                `--db-subnet-group-description 'Private subnets only' --subnet-ids <private-subnet-id-a> <private-subnet-id-b>`,
            ),
            aws(
              node,
              context,
              `rds ${rdsTarget(node)} --db-subnet-group-name ${q(`${node.name}-private`)} --apply-immediately`,
            ),
          ],
          caution:
            'Moving to a new subnet group in the same VPC causes downtime while the instance moves. ' +
            'Schedule it, and take a snapshot first.',
        },

  'ec2-no-public-ip': (node, context) => ({
    commands: [
      aws(node, context, `ec2 describe-addresses --filters Name=instance-id,Values=${q(instanceId(node))}`),
      aws(node, context, 'ec2 disassociate-address --association-id <association-id-from-above>'),
    ],
    caution:
      'The first command shows whether the address is an Elastic IP; only those can be detached ' +
      'in place. An auto-assigned public IP goes away only when the instance is relaunched into a ' +
      'private subnet. Either way the instance stops being reachable at that address.',
  }),

  'subnet-no-auto-public-ip': (node, context) => ({
    commands: [aws(node, context, `ec2 modify-subnet-attribute --subnet-id ${q(node.id)} --no-map-public-ip-on-launch`)],
    caution: 'Affects future launches only. Anything that expects a public IP at launch in this subnet will not get one.',
  }),

  'public-alb-waf': (node, context) => ({
    commands: [
      aws(node, context, 'wafv2 list-web-acls --scope REGIONAL'),
      aws(node, context, `wafv2 associate-web-acl --web-acl-arn <web-acl-arn> --resource-arn ${q(node.arn ?? node.id)}`),
    ],
    caution:
      'Needs a regional web ACL. If none exists, create one from the AWS managed core rule set, ' +
      'and start its rules in Count mode so legitimate traffic is not blocked before you have looked.',
  }),

  'rds-encrypted': (node, context) => {
    if (node.type === 'rds-cluster') return null
    const id = node.name
    return {
      commands: [
        aws(node, context, `rds create-db-snapshot --db-instance-identifier ${q(id)} --db-snapshot-identifier ${q(`${id}-pre-encryption`)}`),
        aws(node, context, `rds wait db-snapshot-available --db-snapshot-identifier ${q(`${id}-pre-encryption`)}`),
        aws(
          node,
          context,
          `rds copy-db-snapshot --source-db-snapshot-identifier ${q(`${id}-pre-encryption`)} ` +
            `--target-db-snapshot-identifier ${q(`${id}-encrypted`)} --kms-key-id alias/aws/rds`,
        ),
        aws(node, context, `rds wait db-snapshot-available --db-snapshot-identifier ${q(`${id}-encrypted`)}`),
        aws(
          node,
          context,
          `rds restore-db-instance-from-db-snapshot --db-instance-identifier ${q(`${id}-encrypted`)} ` +
            `--db-snapshot-identifier ${q(`${id}-encrypted`)}`,
        ),
      ],
      caution:
        'RDS cannot encrypt an instance in place. This restores an encrypted copy as a new instance ' +
        'with a new endpoint: writes after the snapshot are not in it, so stop writes first and plan ' +
        'the cutover. The original is left running until you delete it.',
    }
  },

  'ebs-encrypted': (node, context) => {
    const volumes = [...new Set(fact(node, 'EBS')?.match(/vol-[0-9a-f]+/g) ?? [])]
    const volumeCommands = (volumes.length > 0 ? volumes : ['<volume-id>']).flatMap((volume) => [
      aws(node, context, `ec2 create-snapshot --volume-id ${q(volume)} --description ${q(`pre-encryption ${volume}`)}`),
      aws(node, context, 'ec2 copy-snapshot --source-snapshot-id <snapshot-id-from-above> ' + `--source-region ${q(regionOf(node))} --encrypted`),
    ])
    return {
      commands: [aws(node, context, 'ec2 enable-ebs-encryption-by-default'), ...volumeCommands],
      caution:
        'The first command stops new volumes in this region being created unencrypted. Existing ' +
        'volumes cannot be encrypted in place: create a volume from the encrypted snapshot, stop ' +
        'the instance, and swap it in. That is downtime for this instance.',
    }
  },

  'elasticache-encrypted-in-transit': (node, context) => ({
    commands: [
      aws(
        node,
        context,
        `elasticache modify-replication-group --replication-group-id ${q(fact(node, 'Replication group') ?? '<replication-group-id>')} ` +
          '--transit-encryption-enabled --transit-encryption-mode preferred --apply-immediately',
      ),
    ],
    caution:
      'Preferred mode accepts both TLS and plain connections, so clients can move over without an ' +
      'outage. Once every client uses TLS, run it again with --transit-encryption-mode required.',
  }),

  'sqs-encrypted': (node, context) => ({
    commands: [
      aws(
        node,
        context,
        `sqs set-queue-attributes --queue-url "$(${aws(node, context, `sqs get-queue-url --queue-name ${q(node.name)} --query QueueUrl --output text`)})" ` +
          '--attributes SqsManagedSseEnabled=true',
      ),
    ],
    caution: null,
  }),

  's3-public-access-blocked': (node, context) => ({
    commands: [
      aws(node, context, `s3api get-bucket-policy-status --bucket ${q(node.name)}`),
      aws(
        node,
        context,
        `s3api put-public-access-block --bucket ${q(node.name)} --public-access-block-configuration ` +
          'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
      ),
    ],
    caution:
      'Breaks anything served straight from the bucket — a static website or public downloads. ' +
      'The first command shows whether the bucket is public today. Serve public content through ' +
      'CloudFront with origin access control instead.',
  }),

  'alb-tls': (node, context) => ({
    commands: [
      aws(node, context, `elbv2 describe-listeners --load-balancer-arn ${q(node.arn ?? node.id)} --query "Listeners[?Protocol=='HTTP'].ListenerArn"`),
      aws(
        node,
        context,
        'elbv2 modify-listener --listener-arn <http-listener-arn> --default-actions ' +
          q(JSON.stringify([{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }])),
      ),
    ],
    caution: 'Needs an HTTPS listener on 443 already; without one the redirect leads nowhere.',
  }),

  'cloudfront-https': (node, context) => {
    const id = fact(node, 'Distribution ID') ?? '<distribution-id>'
    return {
      commands: [
        aws(node, context, `cloudfront get-distribution-config --id ${q(id)} > ${q(`${id}.json`)}`, 'us-east-1'),
        `# Edit ${id}.json: set every ViewerProtocolPolicy to "redirect-to-https", keep only the DistributionConfig object, note the ETag`,
        aws(
          node,
          context,
          `cloudfront update-distribution --id ${q(id)} --distribution-config file://${id}.json --if-match <etag>`,
          'us-east-1',
        ),
      ],
      caution: 'CloudFront has no single-flag update; the configuration is replaced as a whole, so edit only that field.',
    }
  },

  'vpc-flow-logs': (node, context) => ({
    commands: [
      aws(
        node,
        context,
        `ec2 create-flow-logs --resource-type VPC --resource-ids ${q(node.id)} --traffic-type ALL ` +
          '--log-destination-type s3 --log-destination arn:aws:s3:::<log-bucket-name>',
      ),
    ],
    caution: 'S3 is the cheapest destination. Delivery is billed per GB, so check the expected volume on a busy VPC.',
  }),

  'rds-log-exports': (node, context) => {
    const types = logTypesFor(fact(node, 'Engine'))
    const value = types ? JSON.stringify({ EnableLogTypes: types }) : '{"EnableLogTypes":["<log-type>"]}'
    return {
      commands: [aws(node, context, `rds ${rdsTarget(node)} --cloudwatch-logs-export-configuration ${q(value)} --apply-immediately`)],
      caution: 'CloudWatch Logs ingestion is billed per GB; general and audit logs can be large on a busy database.',
    }
  },

  'waf-logging': (node, context) => {
    const scopeRegion = fact(node, 'Scope') === 'CLOUDFRONT' || node.region === 'global' ? 'us-east-1' : regionOf(node)
    // WAF only delivers to log groups whose name starts with aws-waf-logs-.
    const group = `aws-waf-logs-${node.name}`
    const groupArn = `arn:aws:logs:${scopeRegion}:${context.accountId}:log-group:${group}`
    return {
      commands: [
        aws(node, context, `logs create-log-group --log-group-name ${q(group)}`, scopeRegion),
        aws(
          node,
          context,
          `wafv2 put-logging-configuration --logging-configuration ResourceArn=${node.arn ?? node.id},LogDestinationConfigs=${groupArn}`,
          scopeRegion,
        ),
      ],
      caution: 'Logs every request the ACL evaluates; set a retention period on the log group to bound the cost.',
    }
  },

  'rds-backups': (node, context) => ({
    commands: [aws(node, context, `rds ${rdsTarget(node)} --backup-retention-period 7 --apply-immediately`)],
    caution: 'Turning backups on from zero causes a brief outage while the first backup starts. Use a longer period if your policy requires it.',
  }),

  'rds-multi-az': (node, context) => ({
    commands: [aws(node, context, `rds ${rdsTarget(node)} --multi-az`)],
    caution:
      'Roughly doubles the instance cost. Without --apply-immediately it happens in the next ' +
      'maintenance window; the conversion takes a snapshot and can slow I/O while it runs.',
  }),

  'rds-deletion-protection': (node, context) => ({
    commands: [aws(node, context, `rds ${rdsTarget(node)} --deletion-protection --apply-immediately`)],
    caution: null,
  }),

  'ec2-imdsv2': (node, context) => ({
    commands: [
      aws(
        node,
        context,
        'cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name MetadataNoToken ' +
          `--dimensions Name=InstanceId,Value=${q(instanceId(node))} --statistics Sum --period 86400 ` +
          '--start-time $(date -u -v-14d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "14 days ago" +%Y-%m-%dT%H:%M:%SZ) ' +
          '--end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)',
      ),
      aws(node, context, `ec2 modify-instance-metadata-options --instance-id ${q(instanceId(node))} --http-tokens required --http-endpoint enabled`),
    ],
    caution:
      'Software still using IMDSv1 (old SDKs, some agents) loses its credentials. The first ' +
      'command counts IMDSv1 calls over two weeks; if the sums are zero, the change is safe.',
  }),
}

export function fixFor(checkId: string, node: GraphNode, context: FixContext): Fix | undefined {
  const built = BUILDERS[checkId]?.(node, context)
  if (!built) return undefined
  return withInputFlag(built)
}

export const __testing = { q, logTypesFor, BUILDERS }
