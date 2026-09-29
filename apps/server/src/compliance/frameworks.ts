import type { ComplianceControl, ComplianceFramework, FrameworkId } from '@cloudatlas/shared'

/**
 * Framework controls, the per-resource benchmark, and the checks that evidence them.
 *
 * A mapping here is a claim that the check is *evidence toward* the control,
 * not that it satisfies it. Only mappings an auditor would recognise are
 * listed; a check is not attached to a control just to raise its coverage.
 *
 * The controls with no checks matter as much as the rest. They are the
 * requirements a configuration scan cannot see — contracts, access reviews,
 * account-level trails — and listing them is what keeps a green score from
 * reading as "compliant".
 */

type ControlSpec = Omit<ComplianceControl, 'id' | 'framework'>

function framework(
  id: FrameworkId,
  meta: Pick<ComplianceFramework, 'name' | 'version' | 'description'>,
  controls: ControlSpec[],
): ComplianceFramework {
  return {
    id,
    ...meta,
    controls: controls.map((control) => ({ ...control, id: `${id}:${control.ref}`, framework: id })),
  }
}

const NO_CLOUDTRAIL =
  'CloudTrail, AWS Config and log retention are account-level and not collected, so this is only partly assessed.'

const HIPAA = framework(
  'hipaa',
  {
    name: 'HIPAA',
    version: 'Security Rule, 45 CFR Part 164 Subpart C',
    description:
      'Technical and administrative safeguards for electronic protected health information (ePHI).',
  },
  [
    {
      ref: '§164.312(a)(1)',
      title: 'Access control',
      checkIds: [
        'sg-no-world-admin-ports',
        'data-tier-private-subnet',
        'rds-not-public',
        's3-public-access-blocked',
        'ec2-imdsv2',
      ],
      coverageNote: 'IAM policies and user access are not analysed; network and resource exposure is.',
    },
    {
      ref: '§164.312(a)(2)(iv)',
      title: 'Encryption and decryption',
      checkIds: [
        'rds-encrypted',
        'ebs-encrypted',
        'elasticache-encrypted-at-rest',
        'sqs-encrypted',
        's3-encrypted',
      ],
    },
    {
      ref: '§164.312(b)',
      title: 'Audit controls',
      checkIds: ['vpc-flow-logs', 'rds-log-exports', 'waf-logging'],
      coverageNote: NO_CLOUDTRAIL,
    },
    {
      ref: '§164.312(c)(1)',
      title: 'Integrity',
      checkIds: ['rds-deletion-protection'],
      coverageNote: 'S3 versioning and Object Lock are not collected.',
    },
    {
      ref: '§164.312(e)(1)',
      title: 'Transmission security',
      checkIds: ['alb-tls', 'cloudfront-https', 'elasticache-encrypted-in-transit'],
      coverageNote: 'Database connections are not checked for enforced TLS (a parameter group setting).',
    },
    {
      ref: '§164.308(a)(1)(ii)(D)',
      title: 'Information system activity review',
      checkIds: ['vpc-flow-logs', 'rds-log-exports'],
      coverageNote: 'Shows that activity is recorded; whether anyone reviews it is a process question.',
    },
    {
      ref: '§164.308(a)(7)(ii)(A)',
      title: 'Data backup plan',
      checkIds: ['rds-backups'],
      coverageNote: 'AWS Backup plans and EBS snapshot schedules are not collected.',
    },
    {
      ref: '§164.308(a)(7)(i)',
      title: 'Contingency plan',
      checkIds: ['rds-multi-az'],
      coverageNote: 'Only database failover is checked; a tested recovery plan is a process requirement.',
    },
    {
      ref: '§164.308(a)(1)(ii)(A)',
      title: 'Risk analysis',
      checkIds: [],
      coverageNote: 'A documented, periodic risk assessment. This report can be one input to it.',
    },
    {
      ref: '§164.308(b)(1)',
      title: 'Business associate contracts',
      checkIds: [],
      coverageNote: 'A signed BAA with AWS (AWS Artifact) and every other vendor handling ePHI.',
    },
    {
      ref: '§164.312(d)',
      title: 'Person or entity authentication',
      checkIds: [],
      coverageNote: 'MFA and credential policy for IAM users and SSO are not collected.',
    },
  ],
)

const SOC2 = framework(
  'soc2',
  {
    name: 'SOC 2',
    version: 'Trust Services Criteria (2017, rev. 2022)',
    description: 'Security, availability and confidentiality criteria for a service organisation.',
  },
  [
    {
      ref: 'CC6.1',
      title: 'Logical access security and encryption of data at rest',
      checkIds: [
        'rds-encrypted',
        'ebs-encrypted',
        'elasticache-encrypted-at-rest',
        'sqs-encrypted',
        's3-encrypted',
        's3-public-access-blocked',
        'ec2-imdsv2',
      ],
      coverageNote: 'KMS key policies and rotation are not collected.',
    },
    {
      ref: 'CC6.6',
      title: 'Protection against threats from outside the system boundary',
      checkIds: [
        'sg-no-world-admin-ports',
        'data-tier-private-subnet',
        'rds-not-public',
        'ec2-no-public-ip',
        'subnet-no-auto-public-ip',
        'vpc-not-default',
        'public-alb-waf',
      ],
    },
    {
      ref: 'CC6.7',
      title: 'Restricted transmission of data',
      checkIds: ['alb-tls', 'cloudfront-https', 'elasticache-encrypted-in-transit'],
    },
    {
      ref: 'CC7.2',
      title: 'Monitoring of system components for anomalies',
      checkIds: ['vpc-flow-logs', 'rds-log-exports', 'waf-logging'],
      coverageNote: NO_CLOUDTRAIL,
    },
    {
      ref: 'A1.2',
      title: 'Backup and recovery infrastructure',
      checkIds: ['rds-backups', 'rds-multi-az', 'rds-deletion-protection'],
      coverageNote: 'AWS Backup plans and restore testing are not collected.',
    },
    {
      ref: 'CC6.2',
      title: 'User registration and authorisation',
      checkIds: [],
      coverageNote: 'Joiner/mover/leaver process and IAM Identity Center assignments.',
    },
    {
      ref: 'CC6.3',
      title: 'Role-based access and least privilege',
      checkIds: [],
      coverageNote: 'IAM policy contents are not analysed.',
    },
    {
      ref: 'CC7.1',
      title: 'Detection of configuration changes and vulnerabilities',
      checkIds: [],
      coverageNote: 'AWS Config, Security Hub and Inspector status are not collected.',
    },
    {
      ref: 'CC8.1',
      title: 'Change management',
      checkIds: [],
      coverageNote: 'Reviewed, approved and tested changes — evidenced from your delivery pipeline.',
    },
  ],
)

const PCI_DSS = framework(
  'pci-dss',
  {
    name: 'PCI DSS',
    version: 'v4.0.1',
    description: 'Requirements for systems that store, process or transmit cardholder data.',
  },
  [
    {
      ref: '1.3.1',
      title: 'Inbound traffic to the CDE is restricted',
      checkIds: ['sg-no-world-admin-ports', 'subnet-no-auto-public-ip'],
    },
    {
      ref: '1.4.2',
      title: 'Inbound traffic from untrusted networks is restricted',
      checkIds: ['sg-no-world-admin-ports', 'ec2-no-public-ip', 'public-alb-waf'],
    },
    {
      ref: '1.4.4',
      title: 'Stores of cardholder data are not directly reachable from untrusted networks',
      checkIds: ['data-tier-private-subnet', 'rds-not-public', 's3-public-access-blocked'],
    },
    {
      ref: '2.2.1',
      title: 'Configuration standards address known weaknesses',
      checkIds: ['ec2-imdsv2', 'vpc-not-default'],
      coverageNote: 'OS and application hardening baselines are not visible to a scan.',
    },
    {
      ref: '3.5.1',
      title: 'Stored account data is rendered unreadable',
      checkIds: [
        'rds-encrypted',
        'ebs-encrypted',
        'elasticache-encrypted-at-rest',
        'sqs-encrypted',
        's3-encrypted',
      ],
      coverageNote: 'Storage encryption is checked; field-level PAN protection is an application concern.',
    },
    {
      ref: '4.2.1',
      title: 'Strong cryptography over open, public networks',
      checkIds: ['alb-tls', 'cloudfront-https'],
      coverageNote: 'TLS policy versions on listeners are not yet checked.',
    },
    {
      ref: '6.4.2',
      title: 'Public-facing web applications are protected by an automated solution',
      checkIds: ['public-alb-waf'],
    },
    {
      ref: '10.2.1',
      title: 'Audit logs are enabled and active',
      checkIds: ['vpc-flow-logs', 'rds-log-exports', 'waf-logging'],
      coverageNote: NO_CLOUDTRAIL,
    },
    {
      ref: '8.4.2',
      title: 'MFA for all access into the CDE',
      checkIds: [],
      coverageNote: 'IAM and SSO MFA configuration is not collected.',
    },
    {
      ref: '10.5.1',
      title: 'Audit log history is retained for at least 12 months',
      checkIds: [],
      coverageNote: 'Log group and bucket retention are not collected.',
    },
    {
      ref: '11.3.1',
      title: 'Internal vulnerability scans are performed quarterly',
      checkIds: [],
      coverageNote: 'Evidenced from your scanning tool, not from configuration.',
    },
  ],
)

/**
 * The per-resource benchmark. Each control is one Security Hub control id, so
 * a gap here can be matched line for line against a Security Hub finding.
 * Checks with no FSBP equivalent (data tier placement, default VPC use, a WAF
 * on the load balancer) are left unmapped rather than stretched to fit one.
 */
const AWS_FSBP = framework(
  'aws-fsbp',
  {
    name: 'AWS FSBP',
    version: 'AWS Foundational Security Best Practices v1.0.0',
    description: 'The resource-level benchmark AWS Security Hub scores accounts against.',
  },
  [
    { ref: 'EC2.3', title: 'Attached EBS volumes should be encrypted at rest', checkIds: ['ebs-encrypted'] },
    { ref: 'EC2.6', title: 'VPC flow logging should be enabled in all VPCs', checkIds: ['vpc-flow-logs'] },
    { ref: 'EC2.8', title: 'EC2 instances should use IMDSv2', checkIds: ['ec2-imdsv2'] },
    { ref: 'EC2.9', title: 'EC2 instances should not have a public IPv4 address', checkIds: ['ec2-no-public-ip'] },
    {
      ref: 'EC2.15',
      title: 'Subnets should not automatically assign public IP addresses',
      checkIds: ['subnet-no-auto-public-ip'],
    },
    {
      ref: 'EC2.19',
      title: 'Security groups should not allow unrestricted access to high-risk ports',
      checkIds: ['sg-no-world-admin-ports'],
    },
    { ref: 'RDS.2', title: 'RDS instances should prohibit public access', checkIds: ['rds-not-public'] },
    { ref: 'RDS.3', title: 'RDS instances should have encryption at rest enabled', checkIds: ['rds-encrypted'] },
    { ref: 'RDS.5', title: 'RDS instances should be configured with multiple AZs', checkIds: ['rds-multi-az'] },
    { ref: 'RDS.8', title: 'RDS instances should have deletion protection enabled', checkIds: ['rds-deletion-protection'] },
    { ref: 'RDS.9', title: 'RDS instances should publish logs to CloudWatch Logs', checkIds: ['rds-log-exports'] },
    { ref: 'RDS.11', title: 'RDS instances should have automatic backups enabled', checkIds: ['rds-backups'] },
    { ref: 'S3.8', title: 'S3 buckets should block public access', checkIds: ['s3-public-access-blocked'] },
    {
      ref: 'ElastiCache.4',
      title: 'ElastiCache replication groups should be encrypted at rest',
      checkIds: ['elasticache-encrypted-at-rest'],
    },
    {
      ref: 'ElastiCache.5',
      title: 'ElastiCache replication groups should be encrypted in transit',
      checkIds: ['elasticache-encrypted-in-transit'],
    },
    { ref: 'SQS.1', title: 'SQS queues should be encrypted at rest', checkIds: ['sqs-encrypted'] },
    { ref: 'ELB.1', title: 'ALBs should redirect all HTTP requests to HTTPS', checkIds: ['alb-tls'] },
    { ref: 'CloudFront.3', title: 'CloudFront distributions should require encryption in transit', checkIds: ['cloudfront-https'] },
    { ref: 'WAF.11', title: 'WAF web ACL logging should be enabled', checkIds: ['waf-logging'] },
    {
      ref: 'CloudTrail.1',
      title: 'CloudTrail should be enabled with at least one multi-Region trail',
      checkIds: [],
      coverageNote: 'CloudTrail configuration is not collected.',
    },
    {
      ref: 'GuardDuty.1',
      title: 'GuardDuty should be enabled',
      checkIds: [],
      coverageNote: 'GuardDuty status is not collected.',
    },
    {
      ref: 'Config.1',
      title: 'AWS Config should be enabled',
      checkIds: [],
      coverageNote: 'AWS Config recorder status is not collected.',
    },
  ],
)

export const FRAMEWORKS: ComplianceFramework[] = [HIPAA, SOC2, PCI_DSS, AWS_FSBP]
