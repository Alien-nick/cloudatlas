import { z } from 'zod'

/**
 * Broad grouping used for the canvas tile colour and the sidebar service filter.
 * Matches the design's CAT palette.
 */
export const nodeCategorySchema = z.enum([
  'compute',
  'network',
  'database',
  'storage',
  'integration',
  'security',
])
export type NodeCategory = z.infer<typeof nodeCategorySchema>

/**
 * Concrete resource kinds. Container kinds (`region`/`vpc`/`az`/`subnet`/`lane`)
 * become compound parents in the ELK layout; everything else is a leaf tile.
 */
export const nodeTypeSchema = z.enum([
  // containers
  'region',
  'vpc',
  'az',
  'subnet',
  'lane',
  // compute
  'ec2',
  'ecs-service',
  'ecs-task',
  'lambda',
  // network
  'alb',
  'nlb',
  'target-group',
  'nat-gateway',
  'internet-gateway',
  'cloudfront',
  'route53-zone',
  'eni',
  'vpc-endpoint',
  // database
  'rds',
  'rds-cluster',
  'elasticache',
  // storage
  's3',
  'ebs-volume',
  // integration
  'sqs',
  'sns',
  'eventbridge-rule',
  // security
  'security-group',
  'waf-web-acl',
  'network-firewall',
  'iam-role',
  // synthetic
  'internet',
])
export type NodeType = z.infer<typeof nodeTypeSchema>

export const CONTAINER_NODE_TYPES = ['region', 'vpc', 'az', 'subnet', 'lane'] as const
export type ContainerNodeType = (typeof CONTAINER_NODE_TYPES)[number]

export function isContainerType(type: NodeType): type is ContainerNodeType {
  return (CONTAINER_NODE_TYPES as readonly string[]).includes(type)
}

export const healthSchema = z.enum(['ok', 'warn', 'critical', 'unknown'])
export type Health = z.infer<typeof healthSchema>

export const severitySchema = z.enum(['critical', 'warning', 'info'])
export type Severity = z.infer<typeof severitySchema>

/**
 * One row of the detail panel's Overview tab. Ordered, because the order is
 * meaningful (identity first, then config, then lifecycle).
 */
export const propEntrySchema = z.object({
  k: z.string(),
  v: z.string(),
  /** Render the value in JetBrains Mono (ids, ARNs, CIDRs, endpoints). */
  mono: z.boolean().optional(),
})
export type PropEntry = z.infer<typeof propEntrySchema>

export const tagSchema = z.object({ key: z.string(), value: z.string() })
export type Tag = z.infer<typeof tagSchema>

export const securityGroupRuleSchema = z.object({
  direction: z.enum(['in', 'out']),
  protocol: z.string(),
  /** Human port range: "22", "8080", "all", "1024-65535". */
  port: z.string(),
  fromPort: z.number().nullable(),
  toPort: z.number().nullable(),
  /** CIDR, security group id, or prefix list id. */
  source: z.string(),
  description: z.string().optional(),
  /** True when this rule exposes a sensitive port to the whole internet. */
  risky: z.boolean().optional(),
})
export type SecurityGroupRule = z.infer<typeof securityGroupRuleSchema>

export const securityGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  vpcId: z.string().nullable(),
  rules: z.array(securityGroupRuleSchema),
})
export type SecurityGroup = z.infer<typeof securityGroupSchema>

export const targetGroupRefSchema = z.object({
  /** Display name, e.g. "tg-api". */
  name: z.string(),
  /** CloudWatch dimension value, e.g. "targetgroup/tg-api/9d2c4f1a". */
  dimension: z.string(),
})
export type TargetGroupRef = z.infer<typeof targetGroupRefSchema>

export const graphNodeSchema = z.object({
  id: z.string(),
  arn: z.string().nullable(),
  type: nodeTypeSchema,
  category: nodeCategorySchema,
  name: z.string(),
  /** Short tile caption, e.g. "RDS", "ALB", "λ". */
  abbr: z.string(),
  /** Secondary line under the tile label, e.g. "db.r6g.2xlarge". */
  subtitle: z.string().optional(),
  /** Human type label, e.g. "RDS PostgreSQL instance". */
  typeLabel: z.string(),
  region: z.string(),
  az: z.string().nullable(),
  vpcId: z.string().nullable(),
  subnetId: z.string().nullable(),
  /** Compound-layout parent. Null for top-level containers. */
  parentId: z.string().nullable(),
  state: z.string(),
  tags: z.array(tagSchema),
  props: z.array(propEntrySchema),
  /** Full describe output, shown in the JSON tab. */
  raw: z.unknown(),
  logGroups: z.array(z.string()),
  health: healthSchema,
  securityGroupIds: z.array(z.string()),
  /** Estimated monthly USD. Only populated when cost lookup is enabled. */
  monthlyCostUsd: z.number().nullable(),
  /** CIDR for vpc/subnet containers. */
  cidr: z.string().optional(),
  /** Subnet containers only: route table has 0.0.0.0/0 -> igw-*. */
  isPublic: z.boolean().optional(),
  /**
   * Load balancers only: the TargetGroup dimension values attached to this LB.
   * CloudWatch publishes HealthyHostCount and UnHealthyHostCount per target
   * group, not per load balancer, so a query without this returns an empty
   * result rather than an error.
   */
  targetGroups: z.array(targetGroupRefSchema).optional(),
  /** Deep link to the AWS console for this resource. */
  consoleUrl: z.string().nullable(),
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const edgeKindSchema = z.enum(['traffic', 'sg', 'event', 'risk'])
export type EdgeKind = z.infer<typeof edgeKindSchema>

export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: edgeKindSchema,
  /** Port or event name rendered on the edge in Security Groups view. */
  label: z.string().optional(),
  meta: z.record(z.string(), z.string()).default({}),
})
export type GraphEdge = z.infer<typeof graphEdgeSchema>

export const findingKindSchema = z.enum([
  'alarm',
  'metric-spike',
  'waf-surge',
  'status-check',
  'risky-sg-rule',
  'public-database',
  'unencrypted-storage',
  'imdsv1-allowed',
])
export type FindingKind = z.infer<typeof findingKindSchema>

/** Posture findings are configuration issues, not live incidents. */
export const POSTURE_FINDING_KINDS: readonly FindingKind[] = [
  'risky-sg-rule',
  'public-database',
  'unencrypted-storage',
  'imdsv1-allowed',
]

export function isPostureFinding(kind: FindingKind): boolean {
  return POSTURE_FINDING_KINDS.includes(kind)
}

export const findingSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  severity: severitySchema,
  kind: findingKindSchema,
  title: z.string(),
  detail: z.string(),
  /** Metric that triggered the finding, when applicable. */
  metric: z.string().nullable(),
  /** Epoch ms. */
  startedAt: z.number(),
  /** Epoch ms; null while still firing. */
  endedAt: z.number().nullable(),
  /** Short supporting facts: observed value, baseline, threshold. */
  evidence: z.array(z.string()),
  /** Small series for the sparkline in the Health view. */
  sparkline: z.array(z.number()).default([]),
  /** Log groups worth opening for this finding. */
  logGroups: z.array(z.string()).default([]),
})
export type Finding = z.infer<typeof findingSchema>

export const alarmStateSchema = z.enum(['OK', 'ALARM', 'INSUFFICIENT_DATA'])
export type AlarmState = z.infer<typeof alarmStateSchema>

export const alarmSchema = z.object({
  name: z.string(),
  arn: z.string().nullable(),
  state: alarmStateSchema,
  reason: z.string(),
  /** Epoch ms of the last state change. */
  updatedAt: z.number(),
  metricName: z.string().nullable(),
  namespace: z.string().nullable(),
  /** Resolved graph node, when the alarm dimensions matched one. */
  nodeId: z.string().nullable(),
  region: z.string(),
  threshold: z.number().nullable(),
  comparisonOperator: z.string().nullable(),
})
export type Alarm = z.infer<typeof alarmSchema>

export const regionSummarySchema = z.object({
  id: z.string(),
  /** Number of non-container resources discovered. */
  count: z.number(),
})
export type RegionSummary = z.infer<typeof regionSummarySchema>

/** Sections a notice can attach to. Mirrors the collectors' own grouping. */
export const collectorSectionSchema = z.enum([
  'vpc',
  'compute',
  'network',
  'database',
  'security',
  'health',
])
export type CollectorSection = z.infer<typeof collectorSectionSchema>

export const SECTION_LABELS: Record<CollectorSection, string> = {
  vpc: 'Network topology',
  compute: 'Compute',
  network: 'Load balancing',
  database: 'Databases',
  security: 'Security groups',
  health: 'Alarms',
}

/** A permission the scan needed but did not have. Surfaced, never fatal. */
export const missingPermissionSchema = z.object({
  /** e.g. "wafv2:ListWebACLs" */
  action: z.string(),
  region: z.string(),
  /** UI section to attach the notice to, e.g. "security" or "database". */
  section: z.string(),
  message: z.string(),
})
export type MissingPermission = z.infer<typeof missingPermissionSchema>

/**
 * A collector call that failed in a way no classifier recognised.
 *
 * Deliberately distinct from `MissingPermission`. A missing permission is a
 * known, actionable state — attach the action and move on. This one means "we
 * do not know what went wrong", and the UI has to say so rather than guessing
 * that it was a denial.
 */
export const collectorFailureSchema = z.object({
  service: z.string(),
  operation: z.string(),
  region: z.string(),
  section: z.string(),
  errorName: z.string(),
  errorCode: z.string().nullable(),
  message: z.string(),
})
export type CollectorFailure = z.infer<typeof collectorFailureSchema>

export const graphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  securityGroups: z.array(securityGroupSchema),
  regions: z.array(regionSummarySchema),
  missingPermissions: z.array(missingPermissionSchema),
  /** Calls that failed for a reason we could not classify. Usually empty. */
  collectorFailures: z.array(collectorFailureSchema).default([]),
  /** Epoch ms when this scan completed. */
  scannedAt: z.number(),
  accountId: z.string(),
  accountAlias: z.string().nullable(),
  profile: z.string(),
})
export type Graph = z.infer<typeof graphSchema>

/**
 * Category colours, taken from the official AWS Architecture Icons palette so
 * the sidebar swatches, edge tints and icon tiles all agree.
 *
 * These match the design's CAT block except for `database`: the design used the
 * older blue (#3B82F6), while AWS's current Databases category — and therefore
 * every RDS and ElastiCache icon we ship — is magenta.
 */
export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  compute: '#ED7100',
  network: '#8C4FFF',
  database: '#C925D1',
  storage: '#7AA116',
  integration: '#E7157B',
  security: '#DD344C',
}

/** Tile colour for a resource that is stopped/terminated. */
export const INACTIVE_COLOR = '#6b7480'

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  compute: 'Compute',
  network: 'Networking',
  database: 'Database',
  storage: 'Storage',
  integration: 'Integration',
  security: 'Security & identity',
}

const ACTIVE_STATES = new Set([
  'running',
  'available',
  'active',
  'deployed',
  'ready',
  'in-use',
  'issued',
])

export function isActiveState(state: string): boolean {
  return ACTIVE_STATES.has(state.toLowerCase())
}

export const EDGE_STYLES: Record<EdgeKind, { dash: string; label: string }> = {
  traffic: { dash: '0', label: 'Traffic' },
  sg: { dash: '6 5', label: 'Security group' },
  event: { dash: '2 5', label: 'Event trigger' },
  risk: { dash: '6 4', label: 'Risky rule' },
}

/** Ports we consider sensitive when open to 0.0.0.0/0 or ::/0. */
export const SENSITIVE_PORTS: Record<number, string> = {
  22: 'SSH',
  3389: 'RDP',
  5432: 'PostgreSQL',
  3306: 'MySQL',
  6379: 'Redis',
  27017: 'MongoDB',
  1433: 'MSSQL',
  9200: 'Elasticsearch',
}

export const WORLD_CIDRS = ['0.0.0.0/0', '::/0']

/** Stable id of the synthetic node representing the public internet. */
export const INTERNET_NODE_ID = 'internet'
