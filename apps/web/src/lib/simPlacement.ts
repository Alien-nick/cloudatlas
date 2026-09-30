import {
  SIM_CATALOG,
  defaultSettings,
  type Graph,
  type GraphNode,
  type SettingValue,
  type SimResource,
  type SimResourceType,
} from '@cloudatlas/shared'

/**
 * Where a new resource goes, worked out from where it was dropped.
 *
 * Adding should be one gesture: drop a database on a subnet, a subnet on a
 * VPC, a bucket anywhere. Whatever is not implied by the drop target is filled
 * with a sensible default — the right kind of subnet, a free CIDR, a name —
 * and can be changed afterwards in the side panel.
 */

export type Placement = Omit<SimResource, 'id'>

/** The drag payload type the palette sets; anything else dropped on the canvas is ignored. */
export const SIM_DRAG_TYPE = 'application/x-cloudatlas-sim'

/** Load balancers and NAT gateways belong in public subnets; everything else in private ones. */
const WANTS_PUBLIC = new Set<SimResourceType>(['alb', 'nat-gateway'])

// ---------------------------------------------------------------------------
// CIDR arithmetic, IPv4 only
// ---------------------------------------------------------------------------

function toInt(ip: string): number {
  return ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
}

function toIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.')
}

function parseCidr(cidr: string | undefined): { start: number; size: number } | null {
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr ?? '')
  if (!match) return null
  return { start: toInt(match[1]!), size: 2 ** (32 - Number(match[2])) }
}

function overlaps(a: { start: number; size: number }, b: { start: number; size: number }): boolean {
  return a.start < b.start + b.size && b.start < a.start + a.size
}

/** The first /24 inside the VPC that no subnet uses yet. */
export function freeSubnetCidr(graph: Graph, vpcId: string): string | null {
  const vpc = parseCidr(graph.nodes.find((node) => node.id === vpcId)?.cidr)
  if (!vpc) return null
  const used = graph.nodes
    .filter((node) => node.type === 'subnet' && node.vpcId === vpcId)
    .map((node) => parseCidr(node.cidr))
    .filter((range): range is { start: number; size: number } => range !== null)
  for (let start = vpc.start; start + 256 <= vpc.start + vpc.size; start += 256) {
    const candidate = { start, size: 256 }
    if (!used.some((range) => overlaps(range, candidate))) return `${toIp(start)}/24`
  }
  return null
}

/** The first 10.x.0.0/16 no VPC in the region uses. */
export function freeVpcCidr(graph: Graph, region: string): string {
  const used = graph.nodes
    .filter((node) => node.type === 'vpc' && node.region === region)
    .map((node) => parseCidr(node.cidr))
    .filter((range): range is { start: number; size: number } => range !== null)
  for (let second = 20; second < 256; second++) {
    const candidate = { start: toInt(`10.${second}.0.0`), size: 65536 }
    if (!used.some((range) => overlaps(range, candidate))) return `10.${second}.0.0/16`
  }
  return '10.20.0.0/16'
}

/** A zone letter the VPC has fewest subnets in, so new subnets spread out. */
function quietZone(graph: Graph, vpcId: string): string {
  const counts = new Map<string, number>([['a', 0], ['b', 0], ['c', 0]])
  for (const node of graph.nodes) {
    if (node.type !== 'subnet' || node.vpcId !== vpcId || !node.az) continue
    const letter = node.az.slice(-1)
    counts.set(letter, (counts.get(letter) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0]![0]
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const SHORT: Record<SimResourceType, string> = {
  vpc: 'vpc',
  subnet: 'subnet',
  ec2: 'app',
  rds: 'db',
  elasticache: 'cache',
  alb: 'alb',
  'nat-gateway': 'nat',
  'ecs-task': 'task',
  lambda: 'fn',
  s3: 'bucket',
  sqs: 'queue',
}

/** `db-1`, `db-2`… — the next number not already taken in the simulation. */
export function nextName(graph: Graph, type: SimResourceType, qualifier = ''): string {
  const stem = qualifier ? `${SHORT[type]}-${qualifier}` : SHORT[type]
  const taken = new Set(graph.nodes.map((node) => node.name))
  for (let n = 1; ; n++) {
    const name = `${stem}-${n}`
    if (!taken.has(name)) return name
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const RESOURCE_CONTAINERS = new Set(['region', 'lane', 'az', 'vpc', 'subnet', 'internet'])

/**
 * The placement for a new resource of `type`, dropped on (or added to)
 * `targetId` — any node, container or not — or, without a target, the first
 * sensible place in the simulation. Returns a reason instead when it cannot go
 * there, such as a database dropped on a VPC with no subnets.
 */
export function placeResource(
  graph: Graph,
  type: SimResourceType,
  targetId: string | null,
): Placement | { error: string } {
  const entry = SIM_CATALOG.find((candidate) => candidate.type === type)!
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const target = targetId ? byId.get(targetId) : undefined

  // Dropping onto a resource means "next to it": use the container it sits in.
  const subnetOf = (node: GraphNode | undefined): GraphNode | undefined =>
    node?.type === 'subnet' ? node : node?.subnetId && !RESOURCE_CONTAINERS.has(node.type) ? byId.get(node.subnetId) : undefined
  const firstVpc = (region?: string) =>
    graph.nodes.find((node) => node.type === 'vpc' && (!region || node.region === region))

  let region = target?.region ?? graph.nodes.find((node) => node.type === 'region')?.region ?? ''
  if (!region) return { error: 'The simulation has no region to place it in.' }
  let vpc = target?.type === 'vpc' ? target : target?.vpcId ? byId.get(target.vpcId) : undefined
  if (!vpc && entry.placement !== 'region') {
    // Dropped outside any network (on a region or the services lane): the
    // first VPC in that region, then any VPC at all.
    vpc = firstVpc(region) ?? firstVpc()
    if (vpc) region = vpc.region
  }

  const settings: Record<string, SettingValue> = defaultSettings(type)
  const base = { type, region, settings }

  if (entry.placement === 'region') {
    if (type === 'vpc') settings.cidr = freeVpcCidr(graph, region)
    return { ...base, name: nextName(graph, type), vpcId: null, subnetId: null }
  }

  if (!vpc) return { error: `Add a VPC first — a ${entry.label} lives inside one.` }

  if (entry.placement === 'vpc') {
    const cidr = freeSubnetCidr(graph, vpc.id)
    if (!cidr) return { error: `${vpc.name} has no free /24 left for another subnet.` }
    const isPublic = target?.type === 'subnet' ? Boolean(target.isPublic) : false
    settings.cidr = cidr
    settings.az = quietZone(graph, vpc.id)
    settings.public = isPublic
    return { ...base, name: nextName(graph, type, isPublic ? 'public' : 'private'), vpcId: vpc.id, subnetId: null }
  }

  // Placement 'subnet': the subnet dropped on, else the best one in the VPC.
  const wantsPublic = WANTS_PUBLIC.has(type)
  let subnet = subnetOf(target)
  if (!subnet) {
    const inVpc = graph.nodes.filter((node) => node.type === 'subnet' && node.vpcId === vpc!.id)
    subnet = inVpc.find((node) => Boolean(node.isPublic) === wantsPublic) ?? inVpc[0]
  }
  if (!subnet) return { error: `${vpc.name} has no subnets yet — add one first, then drop the ${entry.label} on it.` }
  return { ...base, name: nextName(graph, type), vpcId: vpc.id, subnetId: subnet.id }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** The port a connection to `target` usually uses; null for service access through IAM. */
export function defaultPort(target: GraphNode | undefined, settings: Record<string, SettingValue> | undefined): number | null {
  switch (target?.type) {
    case 'rds':
    case 'rds-cluster':
      return settings?.engine === 'mysql' || settings?.engine === 'mariadb' ? 3306 : 5432
    case 'elasticache':
      return 6379
    case 'ecs-task':
      return 8080
    case 'alb':
    case 'nlb':
    case 'ec2':
      return 443
    default:
      return null
  }
}

/** What a palette item of `type` can be dropped into: shown while dragging. */
export function dropsInto(type: SimResourceType): Set<string> {
  const placement = SIM_CATALOG.find((entry) => entry.type === type)?.placement
  if (placement === 'subnet') return new Set(['subnet'])
  if (placement === 'vpc') return new Set(['vpc'])
  return new Set(['region', 'lane'])
}
