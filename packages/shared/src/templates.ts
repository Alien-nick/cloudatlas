import { z } from 'zod'
import { defaultSettings, simChangeSchema, type SettingValue, type SimChange, type SimResourceType } from './simulation.js'

/**
 * Project templates: a starting design, as a change log.
 *
 * A template is exactly what a user could have drawn by hand — resources
 * added and connected in order — so starting from one is the same as having
 * sketched it, and everything after is ordinary editing. Built-in templates
 * are written for any region; a saved one is moved to the region the new
 * project is in.
 */

export const projectTemplateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  /** Built into CloudAtlas, or saved from a project. */
  builtIn: z.boolean(),
  /** Resource types it contains, for the gallery card. */
  types: z.array(z.string()),
  resourceCount: z.number(),
  createdAt: z.number(),
  changes: z.array(simChangeSchema),
})
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>

/** The gallery, without the change logs. */
export const projectTemplateSummarySchema = projectTemplateSchema.omit({ changes: true })
export type ProjectTemplateSummary = z.infer<typeof projectTemplateSummarySchema>

export function summarizeTemplate(template: ProjectTemplate): ProjectTemplateSummary {
  const { changes: _changes, ...rest } = template
  return rest
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A small DSL so each template reads as the architecture it describes. */
class Sketch {
  readonly changes: SimChange[] = []
  private links = 0

  constructor(private readonly region: string) {}

  add(
    type: SimResourceType,
    key: string,
    name: string,
    where: { vpc?: string; subnet?: string } = {},
    settings: Record<string, SettingValue> = {},
  ): string {
    const id = `sim-${key}`
    this.changes.push({
      op: 'add',
      resource: {
        id,
        type,
        name,
        region: this.region,
        vpcId: where.vpc ?? null,
        subnetId: where.subnet ?? null,
        settings: { ...defaultSettings(type), ...settings },
      },
    })
    return id
  }

  connect(source: string, target: string, port: number | null): void {
    this.changes.push({ op: 'connect', id: `link-t${++this.links}`, source, target, port })
  }

  /** A VPC with a public and a private subnet in each of two zones. */
  network(cidrSecond: number): { vpc: string; publicA: string; publicB: string; privateA: string; privateB: string } {
    const vpc = this.add('vpc', 'vpc', 'main-vpc', {}, { cidr: `10.${cidrSecond}.0.0/16` })
    const subnet = (key: string, name: string, third: number, az: string, isPublic: boolean) =>
      this.add('subnet', key, name, { vpc }, { cidr: `10.${cidrSecond}.${third}.0/24`, az, public: isPublic })
    return {
      vpc,
      publicA: subnet('public-a', 'public-a', 1, 'a', true),
      publicB: subnet('public-b', 'public-b', 2, 'b', true),
      privateA: subnet('private-a', 'private-a', 11, 'a', false),
      privateB: subnet('private-b', 'private-b', 12, 'b', false),
    }
  }
}

interface BuiltIn {
  id: string
  name: string
  description: string
  build: (sketch: Sketch) => void
}

const BUILT_INS: BuiltIn[] = [
  {
    id: 'three-tier-web',
    name: 'Three-tier web app',
    description:
      'A load balancer in public subnets, app servers in private ones across two zones, and a Multi-AZ Postgres database. The classic starting point.',
    build: (s) => {
      const net = s.network(30)
      s.add('nat-gateway', 'nat', 'nat-a', { vpc: net.vpc, subnet: net.publicA })
      const alb = s.add('alb', 'alb', 'web-alb', { vpc: net.vpc, subnet: net.publicA })
      const appA = s.add('ec2', 'app-a', 'app-a', { vpc: net.vpc, subnet: net.privateA })
      const appB = s.add('ec2', 'app-b', 'app-b', { vpc: net.vpc, subnet: net.privateB })
      const db = s.add('rds', 'db', 'app-db', { vpc: net.vpc, subnet: net.privateA })
      const assets = s.add('s3', 'assets', 'app-assets')
      s.connect(alb, appA, 8080)
      s.connect(alb, appB, 8080)
      s.connect(appA, db, 5432)
      s.connect(appB, db, 5432)
      s.connect(appA, assets, null)
      s.connect(appB, assets, null)
    },
  },
  {
    id: 'container-api',
    name: 'Containerised API',
    description:
      'Fargate services behind a load balancer, with Redis for caching, Postgres for data and a queue for background work.',
    build: (s) => {
      const net = s.network(40)
      s.add('nat-gateway', 'nat', 'nat-a', { vpc: net.vpc, subnet: net.publicA })
      const alb = s.add('alb', 'alb', 'api-alb', { vpc: net.vpc, subnet: net.publicA })
      const apiA = s.add('ecs-task', 'api-a', 'api-a', { vpc: net.vpc, subnet: net.privateA })
      const apiB = s.add('ecs-task', 'api-b', 'api-b', { vpc: net.vpc, subnet: net.privateB })
      const worker = s.add('ecs-task', 'worker', 'worker', { vpc: net.vpc, subnet: net.privateB })
      const cache = s.add('elasticache', 'cache', 'api-cache', { vpc: net.vpc, subnet: net.privateA })
      const db = s.add('rds', 'db', 'api-db', { vpc: net.vpc, subnet: net.privateA })
      const jobs = s.add('sqs', 'jobs', 'jobs')
      for (const api of [apiA, apiB]) {
        s.connect(alb, api, 8080)
        s.connect(api, cache, 6379)
        s.connect(api, db, 5432)
        s.connect(api, jobs, null)
      }
      s.connect(worker, jobs, null)
      s.connect(worker, db, 5432)
    },
  },
  {
    id: 'serverless',
    name: 'Serverless backend',
    description:
      'Functions, a queue and a bucket — no network to run. Upload to S3, queue the work, process it in Lambda.',
    build: (s) => {
      const uploads = s.add('s3', 'uploads', 'uploads')
      const jobs = s.add('sqs', 'jobs', 'jobs')
      const api = s.add('lambda', 'api', 'api', {}, { memoryMB: 512 })
      const worker = s.add('lambda', 'worker', 'worker', {}, { memoryMB: 1024 })
      s.connect(api, uploads, null)
      s.connect(api, jobs, null)
      s.connect(worker, jobs, null)
      s.connect(worker, uploads, null)
    },
  },
  {
    id: 'network-only',
    name: 'Network foundation',
    description:
      'Just the network: a VPC, public and private subnets in two zones and a NAT gateway. Add the workload yourself.',
    build: (s) => {
      const net = s.network(50)
      s.add('nat-gateway', 'nat', 'nat-a', { vpc: net.vpc, subnet: net.publicA })
    },
  },
]

function describe(id: string, name: string, description: string, changes: SimChange[], builtIn: boolean, createdAt: number): ProjectTemplate {
  const types = [...new Set(changes.flatMap((change) => (change.op === 'add' ? [change.resource.type] : [])))]
  return {
    id,
    name,
    description,
    builtIn,
    types,
    resourceCount: changes.filter((change) => change.op === 'add').length,
    createdAt,
    changes,
  }
}

/** The built-in templates, laid out in `region`. */
export function builtInTemplates(region = 'us-east-1'): ProjectTemplate[] {
  return BUILT_INS.map((entry) => {
    const sketch = new Sketch(region)
    entry.build(sketch)
    return describe(entry.id, entry.name, entry.description, sketch.changes, true, 0)
  })
}

/** A saved template from a project's change log. */
export function templateFromChanges(id: string, name: string, description: string, changes: SimChange[], now: number): ProjectTemplate {
  return describe(id, name, description, changes, false, now)
}

/**
 * A template's changes, moved to `region`. Designs saved from one region are
 * reused in another; everything in a template is new, so only the region on
 * each added resource changes.
 */
export function inRegion(changes: SimChange[], region: string): SimChange[] {
  return changes.map((change) =>
    change.op === 'add' ? { ...change, resource: { ...change.resource, region } } : change,
  )
}
