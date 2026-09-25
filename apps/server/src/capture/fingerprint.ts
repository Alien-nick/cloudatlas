import type { Graph, GraphNode, PropEntry } from '@cloudatlas/shared'

/**
 * Structural identity for a node, independent of its redacted id.
 *
 * Redaction assigns fakes in encounter order, so two captures of the same
 * account produce different ids for the same resource as soon as the call
 * sequence differs — which is exactly what a denied permission does. Matching
 * on id would turn the expected shape of a narrowed-policy capture into a wall
 * of spurious additions and removals.
 *
 * The approach is *normalisation* rather than exclusion: every redaction
 * artefact is rewritten to a canonical token, and the normalised value is used
 * both for identity and for comparison. Excluding those fields instead would
 * have thrown away real signal — `EBS: vol-0000000001 80 GiB gp3` carries a
 * shifting id *and* a volume size, and a size change is drift worth reporting.
 */

/** Resource-id prefixes AWS uses, matched anywhere inside a value. */
const RESOURCE_ID_G =
  /\b(i|vpc|subnet|sg|eni|nat|igw|vgw|rtb|acl|vol|snap|ami|eipalloc|vpce|pl|tgw|fl|dopt|cgw|lt)-[0-9a-f]{6,}\b/g
/** Sequential fakes the redactor mints. */
const PLACEHOLDER_G = /\b(res|host|principal|resource|tagval|tok|description)-\d+\b/g
const ENV_VAR_G = /\bENV_VAR_\d+\b/g
const LOG_GROUP_G = /\/redacted\/lg-\d+\b/g
const ACCOUNT_G = /\b\d{12}\b/g

/**
 * Rewrite every redaction artefact to a canonical token.
 *
 * Two values that normalise the same describe the same thing under different
 * fakes; two that normalise differently describe different things.
 */
export function normalizeUnstable(value: string): string {
  return value
    .replace(RESOURCE_ID_G, (_match, prefix: string) => `${prefix}-<id>`)
    .replace(PLACEHOLDER_G, (_match, prefix: string) => `${prefix}-<n>`)
    .replace(ENV_VAR_G, 'ENV_VAR_<n>')
    .replace(LOG_GROUP_G, '/redacted/lg-<n>')
    .replace(ACCOUNT_G, '<account>')
}

/** True when two values differ only in the fakes redaction assigned. */
export function onlyIdsDiffer(before: string, after: string): boolean {
  if (before === after) return false
  return normalizeUnstable(before) === normalizeUnstable(after)
}

/**
 * Props whose values legitimately move between two runs minutes apart. Excluded
 * from identity so a flapping health check does not look like a different
 * resource, but still compared once a pair is matched.
 */
export const VOLATILE_PROPS = new Set([
  'Status checks',
  'Available IPs',
  'State',
  'Health',
  'Last used',
  'Started',
  'Launched',
  'Created',
  'Last deploy',
])

function stableProps(props: PropEntry[]): string {
  return props
    .filter((prop) => !VOLATILE_PROPS.has(prop.k))
    .map((prop) => `${prop.k}=${normalizeUnstable(prop.v)}`)
    .sort()
    .join(';')
}

/**
 * Build a fingerprint for every node. Parent fingerprints are folded in, so a
 * task in the private subnet of AZ-a is distinguishable from an identical task
 * in AZ-b even when every id differs.
 */
export function fingerprintGraph(graph: Graph): Map<string, string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const memo = new Map<string, string>()
  const inProgress = new Set<string>()

  const compute = (node: GraphNode): string => {
    const cached = memo.get(node.id)
    if (cached) return cached
    // Defensive: a malformed parent cycle must not hang the diff.
    if (inProgress.has(node.id)) return `${node.type}|<cycle>`
    inProgress.add(node.id)

    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const parentPrint = parent ? compute(parent) : 'root'

    const print = [
      node.type,
      node.category,
      node.az ?? '',
      node.cidr ?? '',
      node.isPublic === undefined ? '' : String(node.isPublic),
      node.region,
      normalizeUnstable(node.name),
      normalizeUnstable(node.subtitle ?? ''),
      stableProps(node.props),
      `parent:${parentPrint}`,
    ].join('|')

    inProgress.delete(node.id)
    memo.set(node.id, print)
    return print
  }

  for (const node of graph.nodes) compute(node)
  return memo
}

/**
 * Fields compared once two nodes are paired. A difference here is real unless
 * the two values normalise the same.
 */
export const COMPARED_NODE_FIELDS = [
  'id',
  'type',
  'category',
  'name',
  'abbr',
  'typeLabel',
  'region',
  'az',
  'vpcId',
  'subnetId',
  'parentId',
  'cidr',
  'isPublic',
  'arn',
] as const

/**
 * Signature used to decide whether the members of a fingerprint group are
 * interchangeable. If they are, pairing them in order is harmless. If they are
 * not, any pairing is a guess, and a guess manufactures a fake changed field.
 */
export function interchangeabilitySignature(node: GraphNode): string {
  return [
    node.state,
    node.props
      .filter((prop) => VOLATILE_PROPS.has(prop.k))
      .map((prop) => `${prop.k}=${normalizeUnstable(prop.v)}`)
      .sort()
      .join(';'),
    node.securityGroupIds.length,
    node.logGroups.length,
  ].join('|')
}
