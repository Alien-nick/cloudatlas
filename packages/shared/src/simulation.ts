import { z } from 'zod'
import { fixSchema } from './compliance.js'
import { graphSchema } from './graph.js'

/**
 * Simulations: "what if" copies of a scanned environment.
 *
 * A simulation is a frozen snapshot of the scan it was cloned from, plus an
 * ordered list of changes — resources added, edited, removed, connected. The
 * simulated diagram is the snapshot with the changes replayed on top, in the
 * same shape as a real scan, so the compliance, cost and security-group
 * engines run on it unchanged and its impact is a comparison of two graphs.
 *
 * Nothing here touches AWS. The exports (Terraform, AWS CLI) are text for the
 * user to review and run.
 */

// ---------------------------------------------------------------------------
// The resource catalog
// ---------------------------------------------------------------------------

export const simResourceTypeSchema = z.enum([
  'vpc',
  'subnet',
  'ec2',
  'rds',
  'elasticache',
  'alb',
  'nat-gateway',
  'ecs-task',
  'lambda',
  's3',
  'sqs',
])
export type SimResourceType = z.infer<typeof simResourceTypeSchema>

export type SettingValue = string | number | boolean

export interface SettingField {
  key: string
  label: string
  kind: 'text' | 'number' | 'boolean' | 'select'
  options?: string[]
  default: SettingValue
  /** One line on what it changes, shown under the field. */
  help?: string
}

export interface CatalogEntry {
  type: SimResourceType
  label: string
  /** Where it can live: a region, inside a VPC, or inside a subnet. */
  placement: 'region' | 'vpc' | 'subnet'
  fields: SettingField[]
}

const ENVIRONMENT: SettingField = {
  key: 'environment',
  label: 'Environment tag',
  kind: 'select',
  options: ['prod', 'staging', 'dev'],
  default: 'prod',
  help: 'Non-production resources are held to fewer resilience savings rules.',
}

export const SIM_CATALOG: CatalogEntry[] = [
  {
    type: 'vpc',
    label: 'VPC',
    placement: 'region',
    fields: [
      { key: 'cidr', label: 'CIDR', kind: 'text', default: '10.20.0.0/16' },
      { key: 'flowLogs', label: 'Flow logs', kind: 'boolean', default: true },
      ENVIRONMENT,
    ],
  },
  {
    type: 'subnet',
    label: 'Subnet',
    placement: 'vpc',
    fields: [
      { key: 'cidr', label: 'CIDR', kind: 'text', default: '10.20.1.0/24' },
      { key: 'az', label: 'Availability zone', kind: 'text', default: 'a', help: 'Zone letter, e.g. a, b or c.' },
      { key: 'public', label: 'Public (route to an internet gateway)', kind: 'boolean', default: false },
      { key: 'autoPublicIp', label: 'Auto-assign public IPs', kind: 'boolean', default: false },
    ],
  },
  {
    type: 'ec2',
    label: 'EC2 instance',
    placement: 'subnet',
    fields: [
      {
        key: 'instanceType',
        label: 'Instance type',
        kind: 'select',
        options: ['t4g.medium', 't3.medium', 't3.large', 'm7g.large', 'm6i.large', 'm6i.xlarge', 'c7g.large', 'r6g.large'],
        default: 't3.medium',
      },
      { key: 'volumeGiB', label: 'Root volume (GiB)', kind: 'number', default: 30 },
      { key: 'volumeType', label: 'Volume type', kind: 'select', options: ['gp3', 'gp2'], default: 'gp3' },
      { key: 'encrypted', label: 'Encrypt the volume', kind: 'boolean', default: true },
      { key: 'imdsv2', label: 'Require IMDSv2', kind: 'boolean', default: true },
      { key: 'publicIp', label: 'Public IP address', kind: 'boolean', default: false },
      { key: 'openPorts', label: 'Ports open to the internet', kind: 'text', default: '', help: 'Comma-separated, e.g. 443. Leave empty for none.' },
      ENVIRONMENT,
    ],
  },
  {
    type: 'rds',
    label: 'RDS database',
    placement: 'subnet',
    fields: [
      { key: 'engine', label: 'Engine', kind: 'select', options: ['postgres', 'mysql', 'mariadb'], default: 'postgres' },
      {
        key: 'instanceClass',
        label: 'Instance class',
        kind: 'select',
        options: ['db.t4g.medium', 'db.t3.medium', 'db.m7g.large', 'db.m6i.large', 'db.r6g.large', 'db.r6g.xlarge', 'db.r6g.2xlarge'],
        default: 'db.t4g.medium',
      },
      { key: 'storageGiB', label: 'Storage (GiB)', kind: 'number', default: 100 },
      { key: 'storageType', label: 'Storage type', kind: 'select', options: ['gp3', 'gp2'], default: 'gp3' },
      { key: 'multiAz', label: 'Multi-AZ', kind: 'boolean', default: true },
      { key: 'encrypted', label: 'Encrypt storage', kind: 'boolean', default: true },
      { key: 'publiclyAccessible', label: 'Publicly accessible', kind: 'boolean', default: false },
      { key: 'backupDays', label: 'Backup retention (days)', kind: 'number', default: 7 },
      { key: 'deletionProtection', label: 'Deletion protection', kind: 'boolean', default: true },
      { key: 'logExports', label: 'Export logs to CloudWatch', kind: 'boolean', default: true },
      ENVIRONMENT,
    ],
  },
  {
    type: 'elasticache',
    label: 'ElastiCache (Redis)',
    placement: 'subnet',
    fields: [
      { key: 'nodeType', label: 'Node type', kind: 'select', options: ['cache.t4g.small', 'cache.t4g.medium', 'cache.r6g.large', 'cache.r7g.large'], default: 'cache.t4g.small' },
      { key: 'nodes', label: 'Nodes', kind: 'number', default: 2 },
      { key: 'encryptionAtRest', label: 'Encrypt at rest', kind: 'boolean', default: true },
      { key: 'encryptionInTransit', label: 'Encrypt in transit', kind: 'boolean', default: true },
      ENVIRONMENT,
    ],
  },
  {
    type: 'alb',
    label: 'Application Load Balancer',
    placement: 'subnet',
    fields: [
      { key: 'scheme', label: 'Scheme', kind: 'select', options: ['internet-facing', 'internal'], default: 'internet-facing' },
      { key: 'httpsOnly', label: 'HTTPS, with HTTP redirected', kind: 'boolean', default: true },
      { key: 'waf', label: 'Attach a WAF web ACL', kind: 'boolean', default: true },
      ENVIRONMENT,
    ],
  },
  {
    type: 'nat-gateway',
    label: 'NAT gateway',
    placement: 'subnet',
    fields: [ENVIRONMENT],
  },
  {
    type: 'ecs-task',
    label: 'ECS Fargate task',
    placement: 'subnet',
    fields: [
      { key: 'vcpu', label: 'vCPU', kind: 'select', options: ['0.25', '0.5', '1', '2', '4'], default: '0.5' },
      { key: 'memoryGB', label: 'Memory (GB)', kind: 'number', default: 1 },
      ENVIRONMENT,
    ],
  },
  {
    type: 'lambda',
    label: 'Lambda function',
    placement: 'region',
    fields: [
      { key: 'runtime', label: 'Runtime', kind: 'select', options: ['python3.12', 'nodejs22.x', 'java21'], default: 'python3.12' },
      { key: 'architecture', label: 'Architecture', kind: 'select', options: ['arm64', 'x86_64'], default: 'arm64' },
      { key: 'memoryMB', label: 'Memory (MB)', kind: 'number', default: 512 },
      ENVIRONMENT,
    ],
  },
  {
    type: 's3',
    label: 'S3 bucket',
    placement: 'region',
    fields: [
      { key: 'encryption', label: 'Default encryption', kind: 'select', options: ['aws:kms', 'AES256'], default: 'aws:kms' },
      { key: 'blockPublic', label: 'Block all public access', kind: 'boolean', default: true },
      ENVIRONMENT,
    ],
  },
  {
    type: 'sqs',
    label: 'SQS queue',
    placement: 'region',
    fields: [{ key: 'encrypted', label: 'Encrypt (SSE-SQS)', kind: 'boolean', default: true }, ENVIRONMENT],
  },
]

export function catalogEntry(type: string): CatalogEntry | undefined {
  return SIM_CATALOG.find((entry) => entry.type === type)
}

export function defaultSettings(type: SimResourceType): Record<string, SettingValue> {
  return Object.fromEntries((catalogEntry(type)?.fields ?? []).map((field) => [field.key, field.default]))
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

const settingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

export const simResourceSchema = z.object({
  /** Stable within the project; prefixed "sim-" so it never collides with AWS ids. */
  id: z.string().regex(/^sim-[a-z0-9-]+$/),
  type: simResourceTypeSchema,
  name: z.string().min(1).max(64),
  region: z.string(),
  /** Set for everything placed in a VPC, including subnets. */
  vpcId: z.string().nullable(),
  /** Set for resources placed in a subnet. */
  subnetId: z.string().nullable(),
  settings: settingsSchema,
})
export type SimResource = z.infer<typeof simResourceSchema>

export const simChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), resource: simResourceSchema }),
  /** Settings for an added resource, or for an existing one of a catalog type. */
  z.object({ op: z.literal('update'), nodeId: z.string(), settings: settingsSchema }),
  z.object({ op: z.literal('remove'), nodeId: z.string() }),
  z.object({
    op: z.literal('connect'),
    id: z.string(),
    source: z.string(),
    target: z.string(),
    /** TCP port the target accepts from the source; null for service access (S3, SQS). */
    port: z.number().int().min(1).max(65535).nullable(),
  }),
  z.object({ op: z.literal('disconnect'), connectionId: z.string() }),
])
export type SimChange = z.infer<typeof simChangeSchema>

/** Which part of the scan a simulation covers; null for all of it. */
export const simulationScopeSchema = z.object({
  vpcIds: z.array(z.string()),
  /** Resources outside any VPC: buckets, queues, functions, global services. */
  includeOutside: z.boolean(),
})
export type SimulationScope = z.infer<typeof simulationScopeSchema>

export const simulationSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  profile: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The scan the snapshot came from. */
  baseScannedAt: z.number(),
  /** Reapplied on rebase, so a refreshed snapshot covers the same networks. */
  scope: simulationScopeSchema.nullable().default(null),
  /**
   * `simulation`: a scanned environment plus changes. `project`: a design
   * from scratch — the same thing on an empty snapshot, so every engine and
   * export works on it unchanged.
   */
  kind: z.enum(['simulation', 'project']).default('simulation'),
  /** What a project is for, in the user's words. */
  description: z.string().max(500).default(''),
  /** The template a project started from, if any. */
  templateId: z.string().nullable().default(null),
  changes: z.array(simChangeSchema),
})
export type Simulation = z.infer<typeof simulationSchema>

export const simulationSummarySchema = simulationSchema
  .omit({ changes: true })
  .extend({ changeCount: z.number() })
export type SimulationSummary = z.infer<typeof simulationSummarySchema>

// ---------------------------------------------------------------------------
// The simulated view and its impact
// ---------------------------------------------------------------------------

export const simStatusSchema = z.enum(['added', 'changed'])

export const simulatedSchema = z.object({
  simulation: simulationSchema,
  graph: graphSchema,
  /** Added and changed resources; removed ones are gone from `graph`. */
  status: z.record(z.string(), simStatusSchema),
  removed: z.array(z.object({ id: z.string(), name: z.string(), typeLabel: z.string() })),
  /** Current settings for every editable resource, added or existing. */
  settings: z.record(z.string(), settingsSchema),
  /** Changes that could not be applied, e.g. a connection to a removed resource. */
  problems: z.array(z.string()),
})
export type Simulated = z.infer<typeof simulatedSchema>

export const costDeltaLineSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  change: z.enum(['added', 'changed', 'removed']),
  before: z.number(),
  after: z.number(),
})

export const complianceDeltaSchema = z.object({
  framework: z.string(),
  frameworkName: z.string(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  /** Resource-level results that start failing or stop failing. */
  newGaps: z.array(z.object({ checkId: z.string(), checkTitle: z.string(), nodeId: z.string(), controls: z.array(z.string()) })),
  fixed: z.array(z.object({ checkId: z.string(), checkTitle: z.string(), nodeId: z.string(), controls: z.array(z.string()) })),
})

export const exposurePathSchema = z.object({
  nodeId: z.string(),
  /** Entry point first, this resource last. */
  path: z.array(z.string()),
  entryReason: z.string(),
})

export const simulationImpactSchema = z.object({
  cost: z.object({
    source: z.string(),
    before: z.number(),
    after: z.number(),
    lines: z.array(costDeltaLineSchema),
    /** Added resources that are usage-billed or could not be priced. */
    notEstimated: z.array(z.object({ nodeId: z.string(), reason: z.string() })),
    /** Why prices could not be looked up at all, e.g. a denied permission. */
    message: z.string().nullable().default(null),
  }),
  compliance: z.array(complianceDeltaSchema),
  exposure: z.object({
    newlyReachable: z.array(exposurePathSchema),
    noLongerReachable: z.array(z.object({ nodeId: z.string(), name: z.string() })),
  }),
})
export type SimulationImpact = z.infer<typeof simulationImpactSchema>

export const simulationExportSchema = z.object({
  format: z.enum(['terraform', 'cli']),
  /** The file or script, ready to review. */
  text: z.string(),
  /** Per-step fixes for the CLI format, so the UI can show cautions. */
  steps: z.array(z.object({ title: z.string(), fix: fixSchema })).default([]),
  notes: z.array(z.string()),
})
export type SimulationExport = z.infer<typeof simulationExportSchema>
