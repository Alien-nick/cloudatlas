import type {
  CheckStatus,
  ComplianceCheck,
  Graph,
  GraphEdge,
  GraphNode,
  SecurityGroup,
} from '@cloudatlas/shared'
import { POSTURE_FACTS, isUnencryptedVolumeValue } from '../graph/posture-facts.js'

/**
 * The automated checks behind every compliance control.
 *
 * Each one reads a fact the scan already wrote onto a node, in the vocabulary
 * pinned by `graph/posture-facts.ts` — the same contract the posture detectors
 * use, and for the same reason: it works identically against a live scan, a
 * replayed fixture and the demo provider.
 *
 * The rule every check follows: a fact that is absent is `unknown`, never
 * `pass`. A prop goes missing when a call was denied or a provider does not
 * report it, and reporting that as compliant is the one failure mode a
 * compliance view cannot have.
 */

export interface CheckContext {
  nodeById: Map<string, GraphNode>
  sgById: Map<string, SecurityGroup>
  /** Edges keyed by target node id. */
  inbound: Map<string, GraphEdge[]>
}

export interface CheckOutcome {
  status: CheckStatus
  evidence: string[]
}

export interface CheckDefinition extends ComplianceCheck {
  applies: (node: GraphNode) => boolean
  evaluate: (node: GraphNode, context: CheckContext) => CheckOutcome
}

export function buildCheckContext(graph: Graph): CheckContext {
  const inbound = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    const list = inbound.get(edge.target)
    if (list) list.push(edge)
    else inbound.set(edge.target, [edge])
  }
  return {
    nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
    sgById: new Map(graph.securityGroups.map((sg) => [sg.id, sg])),
    inbound,
  }
}

function fact(node: GraphNode, key: string): string | undefined {
  return node.props.find((prop) => prop.k === key)?.v
}

const pass = (...evidence: string[]): CheckOutcome => ({ status: 'pass', evidence })
const fail = (...evidence: string[]): CheckOutcome => ({ status: 'fail', evidence })
const unknown = (...evidence: string[]): CheckOutcome => ({ status: 'unknown', evidence })

/** The common shape: one prop, a failing value, and anything else passes. */
function factCheck(
  node: GraphNode,
  key: string,
  isFailing: (value: string) => boolean,
  missing: string,
): CheckOutcome {
  const value = fact(node, key)
  if (value === undefined) return unknown(missing)
  return isFailing(value) ? fail(`${key}: ${value}`) : pass(`${key}: ${value}`)
}

const isDatabase = (node: GraphNode): boolean => node.type === 'rds' || node.type === 'rds-cluster'
const isReplica = (node: GraphNode): boolean => fact(node, POSTURE_FACTS.replicaOf.key) !== undefined

/**
 * A read replica inherits failover and backups from its source, and its
 * deletion is not the loss of the data — so resilience checks skip it.
 */
const isPrimaryDatabase = (node: GraphNode): boolean => isDatabase(node) && !isReplica(node)

export const CHECKS: CheckDefinition[] = [
  // --- network exposure --------------------------------------------------
  {
    id: 'sg-no-world-admin-ports',
    title: 'No sensitive port open to the internet',
    category: 'network',
    severity: 'high',
    rationale:
      'A security group admitting SSH, RDP or a database port from 0.0.0.0/0 exposes the resource ' +
      'to every scanner on the internet, and turns a weak credential into a breach.',
    remediation:
      'Replace the 0.0.0.0/0 source with a specific CIDR or security group, or remove the rule and ' +
      'use Session Manager for shell access.',
    appliesTo: ['Any resource with a security group'],
    applies: (node) => node.securityGroupIds.length > 0,
    evaluate: (node, { sgById }) => {
      const exposures: string[] = []
      const missing: string[] = []
      for (const sgId of node.securityGroupIds) {
        const sg = sgById.get(sgId)
        if (!sg) {
          missing.push(sgId)
          continue
        }
        for (const rule of sg.rules) {
          if (rule.risky) {
            exposures.push(`${sg.name} (${sg.id}): inbound ${rule.protocol}/${rule.port} from ${rule.source}`)
          }
        }
      }
      if (exposures.length > 0) return fail(...exposures)
      if (missing.length > 0) return unknown(`Rules not collected for ${missing.join(', ')}`)
      return pass(`${node.securityGroupIds.length} security group(s), none open to the internet on a sensitive port`)
    },
  },
  {
    id: 'data-tier-private-subnet',
    title: 'Data stores sit in private subnets',
    category: 'network',
    severity: 'high',
    rationale:
      'A database or cache in a subnet that routes to an internet gateway is one security group ' +
      'change away from being reachable from the internet.',
    remediation:
      'Move the resource to a DB subnet group made only of private subnets (no 0.0.0.0/0 route ' +
      'to an internet gateway).',
    appliesTo: ['RDS', 'ElastiCache'],
    applies: (node) => isDatabase(node) || node.type === 'elasticache',
    evaluate: (node, { nodeById }) => {
      const subnet = node.subnetId ? nodeById.get(node.subnetId) : undefined
      if (!subnet || subnet.isPublic === undefined) return unknown('Subnet placement was not collected')
      const label = `Subnet: ${subnet.name} (${subnet.id})`
      return subnet.isPublic
        ? fail(label, 'Route table sends 0.0.0.0/0 to an internet gateway')
        : pass(label, 'No route to an internet gateway')
    },
  },
  {
    id: 'rds-not-public',
    title: 'Databases are not publicly accessible',
    category: 'network',
    severity: 'high',
    rationale:
      'A publicly accessible database resolves to a routable address from the internet; only its ' +
      'security group stands between it and every scanner.',
    remediation: 'aws rds modify-db-instance --db-instance-identifier <id> --no-publicly-accessible',
    appliesTo: ['RDS'],
    applies: isDatabase,
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.publiclyAccessible.key,
        (value) => value === POSTURE_FACTS.publiclyAccessible.yes,
        'PubliclyAccessible was not collected',
      ),
  },
  {
    id: 'ec2-no-public-ip',
    title: 'Instances have no public IP address',
    category: 'network',
    severity: 'medium',
    rationale:
      'An instance with its own public address is reachable without passing a load balancer, WAF ' +
      'or firewall, so its security group is the only control in front of it.',
    remediation:
      'Place the instance in a private subnet behind a load balancer or NAT gateway, and release ' +
      'the public or Elastic IP.',
    appliesTo: ['EC2'],
    applies: (node) => node.type === 'ec2',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.publicIpv4.key,
        (value) => !value.startsWith('—'),
        'Public addressing was not collected',
      ),
  },
  {
    id: 'subnet-no-auto-public-ip',
    title: 'Subnets do not auto-assign public IPs',
    category: 'network',
    severity: 'low',
    rationale:
      'With auto-assign on, anything launched into the subnet gets a public address by default, so ' +
      'exposure depends on every future launch remembering to opt out.',
    remediation:
      'aws ec2 modify-subnet-attribute --subnet-id <id> --no-map-public-ip-on-launch. Load ' +
      'balancers and NAT gateways do not need it.',
    appliesTo: ['Subnet'],
    applies: (node) => node.type === 'subnet',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.autoPublicIp.key,
        (value) => value === POSTURE_FACTS.autoPublicIp.enabled,
        'MapPublicIpOnLaunch was not collected',
      ),
  },
  {
    id: 'vpc-not-default',
    title: 'Workloads do not run in the default VPC',
    category: 'network',
    severity: 'low',
    rationale:
      'The default VPC is created with a public subnet in every zone and public IPs on by default. ' +
      'It was not designed, so it has no documented boundary for an auditor to review.',
    remediation: 'Move workloads to a purpose-built VPC with private subnets, then delete the default VPC.',
    appliesTo: ['VPC'],
    applies: (node) => node.type === 'vpc',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.defaultVpc.key,
        (value) => value === POSTURE_FACTS.defaultVpc.yes,
        'IsDefault was not collected',
      ),
  },
  {
    id: 'public-alb-waf',
    title: 'Internet-facing load balancers are behind a WAF',
    category: 'network',
    severity: 'medium',
    rationale:
      'A public web application without a WAF has no filter for injection, credential-stuffing or ' +
      'request floods before traffic reaches the application.',
    remediation:
      'Associate a WAF v2 web ACL with the load balancer, starting from the AWS managed core rule set.',
    appliesTo: ['ALB (internet-facing)'],
    applies: (node) =>
      node.type === 'alb' &&
      fact(node, POSTURE_FACTS.loadBalancerScheme.key) !== 'internal',
    evaluate: (node, { nodeById, inbound }) => {
      if (fact(node, POSTURE_FACTS.loadBalancerScheme.key) === undefined) {
        return unknown('Load balancer scheme was not collected')
      }
      const sources = (inbound.get(node.id) ?? [])
        .map((edge) => nodeById.get(edge.source))
        .filter((source): source is GraphNode => source !== undefined)

      const direct = sources.find((source) => source.type === 'waf-web-acl')
      if (direct) return pass(`Web ACL: ${direct.name}`)

      // Fronted by a protected distribution is real protection, but only for
      // requests that come through it — say so rather than a plain pass.
      for (const distribution of sources.filter((source) => source.type === 'cloudfront')) {
        const acl = (inbound.get(distribution.id) ?? [])
          .map((edge) => nodeById.get(edge.source))
          .find((source) => source?.type === 'waf-web-acl')
        if (acl) {
          return pass(
            `Protected at the edge: ${acl.name} on ${distribution.name}`,
            'Requests sent straight to the load balancer bypass it unless its security group admits only the CloudFront prefix list',
          )
        }
      }
      return fail('No web ACL is associated with this load balancer or a distribution in front of it')
    },
  },

  // --- encryption at rest ------------------------------------------------
  {
    id: 'rds-encrypted',
    title: 'Database storage is encrypted',
    category: 'encryption-at-rest',
    severity: 'high',
    rationale:
      'Unencrypted database storage is readable from any snapshot, and snapshots are easy to share ' +
      'or copy out of an account by mistake.',
    remediation:
      'Encryption cannot be enabled in place: snapshot, copy the snapshot with --kms-key-id, and ' +
      'restore from the copy.',
    appliesTo: ['RDS'],
    applies: isDatabase,
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.storageEncryption.key,
        (value) => value === POSTURE_FACTS.storageEncryption.absent,
        'StorageEncrypted was not collected',
      ),
  },
  {
    id: 'ebs-encrypted',
    title: 'EBS volumes are encrypted',
    category: 'encryption-at-rest',
    severity: 'high',
    rationale: 'An unencrypted volume is readable from any snapshot taken of it.',
    remediation:
      'Snapshot, copy the snapshot with --encrypted, create a volume from it and swap it in. Turn ' +
      'on EBS encryption by default so new volumes cannot regress.',
    appliesTo: ['EC2'],
    applies: (node) => node.type === 'ec2',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.ebsEncryption.key,
        isUnencryptedVolumeValue,
        'Attached volumes were not collected',
      ),
  },
  {
    id: 'elasticache-encrypted-at-rest',
    title: 'Cache data is encrypted at rest',
    category: 'encryption-at-rest',
    severity: 'medium',
    rationale:
      'Caches routinely hold copies of records and session tokens, and their backups are written ' +
      'to disk in the clear without at-rest encryption.',
    remediation: 'At-rest encryption is set at creation: create an encrypted replication group and migrate.',
    appliesTo: ['ElastiCache'],
    applies: (node) => node.type === 'elasticache',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.cacheEncryptionAtRest.key,
        (value) => value === POSTURE_FACTS.cacheEncryptionAtRest.disabled,
        'AtRestEncryptionEnabled was not collected',
      ),
  },
  {
    id: 'sqs-encrypted',
    title: 'Queues are encrypted',
    category: 'encryption-at-rest',
    severity: 'medium',
    rationale: 'Messages frequently carry the same records the database holds, while they wait in the queue.',
    remediation: 'aws sqs set-queue-attributes --attributes SqsManagedSseEnabled=true (or a KMS key).',
    appliesTo: ['SQS'],
    applies: (node) => node.type === 'sqs',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.storageEncryption.key,
        (value) => value === POSTURE_FACTS.storageEncryption.absent,
        'Queue encryption attributes were not collected',
      ),
  },
  {
    id: 's3-encrypted',
    title: 'Buckets are encrypted',
    category: 'encryption-at-rest',
    severity: 'medium',
    rationale:
      'Auditors ask for encryption at rest on every store. S3 applies SSE-S3 to new objects by ' +
      'default, so this passes unless the configuration could not be read.',
    remediation: 'Set a default encryption rule, with SSE-KMS where key access needs to be audited.',
    appliesTo: ['S3'],
    applies: (node) => node.type === 's3',
    evaluate: (node) =>
      factCheck(node, POSTURE_FACTS.storageEncryption.key, () => false, 'Bucket encryption was not collected'),
  },
  {
    id: 's3-public-access-blocked',
    title: 'Buckets block public access',
    category: 'network',
    severity: 'high',
    rationale:
      'Without all four public access block settings, a single ACL or bucket policy change can ' +
      'publish the bucket to the internet.',
    remediation:
      'aws s3api put-public-access-block --bucket <name> --public-access-block-configuration ' +
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    appliesTo: ['S3'],
    applies: (node) => node.type === 's3',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.s3PublicAccess.key,
        (value) => value !== POSTURE_FACTS.s3PublicAccess.blocked,
        'Public access block was not collected',
      ),
  },

  // --- encryption in transit ---------------------------------------------
  {
    id: 'alb-tls',
    title: 'Load balancers do not serve plain HTTP',
    category: 'encryption-in-transit',
    severity: 'high',
    rationale: 'An HTTP listener that does not redirect sends requests, cookies and responses in the clear.',
    remediation: 'Change the HTTP listener default action to a redirect to HTTPS:443, or remove it.',
    appliesTo: ['ALB'],
    applies: (node) => node.type === 'alb',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.plaintextListeners.key,
        (value) => value !== POSTURE_FACTS.plaintextListeners.none,
        'Listener actions were not collected',
      ),
  },
  {
    id: 'cloudfront-https',
    title: 'Distributions require HTTPS',
    category: 'encryption-in-transit',
    severity: 'high',
    rationale: 'A viewer protocol policy of allow-all lets clients fetch content over plain HTTP.',
    remediation: 'Set the viewer protocol policy to redirect-to-https or https-only on every cache behavior.',
    appliesTo: ['CloudFront'],
    applies: (node) => node.type === 'cloudfront',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.viewerProtocol.key,
        (value) => value === POSTURE_FACTS.viewerProtocol.allowAll,
        'Viewer protocol policy was not collected',
      ),
  },
  {
    id: 'elasticache-encrypted-in-transit',
    title: 'Cache traffic is encrypted in transit',
    category: 'encryption-in-transit',
    severity: 'medium',
    rationale: 'Without TLS, anything on the network path can read what the application reads from the cache.',
    remediation: 'Enable in-transit encryption (preferred mode first, then required) and switch clients to TLS.',
    appliesTo: ['ElastiCache'],
    applies: (node) => node.type === 'elasticache',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.cacheEncryptionInTransit.key,
        (value) => value === POSTURE_FACTS.cacheEncryptionInTransit.disabled,
        'TransitEncryptionEnabled was not collected',
      ),
  },

  // --- logging & monitoring ----------------------------------------------
  {
    id: 'vpc-flow-logs',
    title: 'VPC flow logs are enabled',
    category: 'logging',
    severity: 'medium',
    rationale:
      'Flow logs are the only record of which addresses talked to which inside the VPC. Without ' +
      'them, an investigation cannot establish what a compromised host reached.',
    remediation:
      'aws ec2 create-flow-logs --resource-type VPC --resource-ids <vpc-id> --traffic-type ALL ' +
      '--log-destination-type s3 --log-destination <bucket-arn>',
    appliesTo: ['VPC'],
    applies: (node) => node.type === 'vpc',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.flowLogs.key,
        (value) => value === POSTURE_FACTS.flowLogs.absent,
        'Flow log configuration was not collected',
      ),
  },
  {
    id: 'rds-log-exports',
    title: 'Database logs are exported',
    category: 'logging',
    severity: 'medium',
    rationale:
      'Without exported logs, connection and query activity lives only on the instance, is rotated ' +
      'away within days, and cannot be reviewed or alerted on.',
    remediation:
      'aws rds modify-db-instance --cloudwatch-logs-export-configuration EnableLogTypes=<engine log types>',
    appliesTo: ['RDS'],
    applies: isDatabase,
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.logExports.key,
        (value) => value === POSTURE_FACTS.logExports.none,
        'Log export configuration was not collected',
      ),
  },
  {
    id: 'waf-logging',
    title: 'WAF requests are logged',
    category: 'logging',
    severity: 'low',
    rationale: 'Without logging, blocked and allowed requests leave no trace beyond a three-hour sample.',
    remediation: 'aws wafv2 put-logging-configuration with a CloudWatch Logs group, S3 bucket or Firehose stream.',
    appliesTo: ['WAF web ACL'],
    applies: (node) => node.type === 'waf-web-acl',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.wafLogging.key,
        (value) => value === POSTURE_FACTS.wafLogging.absent,
        'Logging configuration was not collected',
      ),
  },

  // --- backup & resilience -----------------------------------------------
  {
    id: 'rds-backups',
    title: 'Databases have automated backups',
    category: 'resilience',
    severity: 'high',
    rationale:
      'With a retention period of zero, there is no point-in-time recovery: a bad migration or a ' +
      'deleted table is permanent.',
    remediation: 'aws rds modify-db-instance --backup-retention-period 7 (or longer, to match your policy).',
    appliesTo: ['RDS (not replicas)'],
    applies: isPrimaryDatabase,
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.backupRetention.key,
        (value) => value === POSTURE_FACTS.backupRetention.disabled,
        'Backup retention was not collected',
      ),
  },
  {
    id: 'rds-multi-az',
    title: 'Databases are Multi-AZ',
    category: 'resilience',
    severity: 'medium',
    rationale:
      'A single-AZ database is unavailable for the length of any zone outage or host failure, and ' +
      'recovery means a restore rather than a failover.',
    remediation: 'aws rds modify-db-instance --multi-az --apply-immediately (brief I/O pause during conversion).',
    appliesTo: ['RDS (not replicas)'],
    applies: (node) => node.type === 'rds' && !isReplica(node),
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.multiAz.key,
        (value) => !value.toLowerCase().startsWith(POSTURE_FACTS.multiAz.enabledPrefix),
        'Multi-AZ setting was not collected',
      ),
  },
  {
    id: 'rds-deletion-protection',
    title: 'Databases have deletion protection',
    category: 'resilience',
    severity: 'low',
    rationale:
      'Without it, a single API call or a mistaken infrastructure change deletes the database and, ' +
      'unless a final snapshot was requested, its automated backups with it.',
    remediation: 'aws rds modify-db-instance --deletion-protection',
    appliesTo: ['RDS (not replicas)'],
    applies: isPrimaryDatabase,
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.deletionProtection.key,
        (value) => value === POSTURE_FACTS.deletionProtection.off,
        'Deletion protection was not collected',
      ),
  },

  // --- hardening ---------------------------------------------------------
  {
    id: 'ec2-imdsv2',
    title: 'Instances require IMDSv2',
    category: 'hardening',
    severity: 'medium',
    rationale:
      'IMDSv1 lets any request forged from the instance read its role credentials, which turns a ' +
      'server-side request forgery bug into credential theft.',
    remediation: 'aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required',
    appliesTo: ['EC2'],
    applies: (node) => node.type === 'ec2',
    evaluate: (node) =>
      factCheck(
        node,
        POSTURE_FACTS.imds.key,
        (value) => value === POSTURE_FACTS.imds.v1Allowed,
        'Metadata options were not collected',
      ),
  },
]
