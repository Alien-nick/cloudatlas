import { INTERNET_NODE_ID, WORLD_CIDRS, isContainerType, type Graph, type GraphNode } from '@cloudatlas/shared'
import { fact } from '../aws/cli-command.js'
import { POSTURE_FACTS } from '../graph/posture-facts.js'

/**
 * What the internet can reach, and how.
 *
 * Entry points are the resources the internet talks to directly: internet-
 * facing load balancers, distributions, publicly accessible databases, open
 * buckets, instances with a public address behind a world-open rule, and
 * anything behind a risky rule. From each, reachability follows traffic and
 * security-group links — "A can connect to B" — to everything downstream.
 *
 * This is an over-approximation by design: a link means a path exists, not
 * that the application uses it. For a "what does this change expose" question
 * that is the safe direction to be wrong in.
 */

export interface Reach {
  /** Entry point first, the resource last. */
  path: string[]
  entryReason: string
}

function entryReason(node: GraphNode, graph: Graph, riskTargets: Set<string>): string | null {
  if (riskTargets.has(node.id)) return 'Sensitive port open to the internet'
  if ((node.type === 'alb' || node.type === 'nlb') && fact(node, POSTURE_FACTS.loadBalancerScheme.key) === 'internet-facing') {
    return 'Internet-facing load balancer'
  }
  if (node.type === 'cloudfront') return 'CloudFront distribution'
  if ((node.type === 'rds' || node.type === 'rds-cluster') && fact(node, POSTURE_FACTS.publiclyAccessible.key) === POSTURE_FACTS.publiclyAccessible.yes) {
    return 'Publicly accessible database'
  }
  if (node.type === 's3' && fact(node, POSTURE_FACTS.s3PublicAccess.key) === POSTURE_FACTS.s3PublicAccess.notBlocked) {
    return 'Bucket not blocking public access'
  }
  if (node.type === 'ec2' && !(fact(node, POSTURE_FACTS.publicIpv4.key) ?? '—').startsWith('—')) {
    const worldOpen = node.securityGroupIds.some((id) =>
      graph.securityGroups.find((sg) => sg.id === id)?.rules.some((rule) => rule.direction === 'in' && WORLD_CIDRS.includes(rule.source)),
    )
    if (worldOpen) return 'Public IP with a world-open rule'
  }
  return null
}

function adjacency(graph: Graph): Map<string, string[]> {
  const next = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const carries = edge.kind === 'traffic' || (edge.kind === 'sg' && edge.meta.via !== 'web ACL association')
    if (!carries || edge.source === INTERNET_NODE_ID) continue
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  }
  return next
}

function entryPoints(graph: Graph): Map<string, string> {
  const riskTargets = new Set(graph.edges.filter((edge) => edge.kind === 'risk').map((edge) => edge.target))
  const entries = new Map<string, string>()
  for (const node of graph.nodes) {
    if (isContainerType(node.type) || node.type === 'internet') continue
    const reason = entryReason(node, graph, riskTargets)
    if (reason) entries.set(node.id, reason)
  }
  return entries
}

/**
 * For every resource, each entry point that can reach it and the shortest
 * path from that entry. Tracked per entry, not just "reachable or not",
 * because the finding that matters in a simulation is often a *new route*
 * to something that was already reachable — an SSH-open jump box with a line
 * to the production database, when the database was already behind the
 * public load balancer.
 */
export function reachByEntry(graph: Graph): Map<string, Map<string, Reach>> {
  const next = adjacency(graph)
  const known = new Set(graph.nodes.map((node) => node.id))
  const byNode = new Map<string, Map<string, Reach>>()
  for (const [entry, reason] of entryPoints(graph)) {
    const seen = new Map<string, string[]>([[entry, [entry]]])
    const queue = [entry]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const target of next.get(current) ?? []) {
        if (seen.has(target) || !known.has(target)) continue
        seen.set(target, [...(seen.get(current) as string[]), target])
        queue.push(target)
      }
    }
    for (const [nodeId, path] of seen) {
      const entries = byNode.get(nodeId) ?? new Map<string, Reach>()
      entries.set(entry, { path, entryReason: reason })
      byNode.set(nodeId, entries)
    }
  }
  return byNode
}

/** Every resource the internet can reach, with its shortest path from any entry point. */
export function internetReach(graph: Graph): Map<string, Reach> {
  const shortest = new Map<string, Reach>()
  for (const [nodeId, entries] of reachByEntry(graph)) {
    const best = [...entries.values()].sort((a, b) => a.path.length - b.path.length)[0]
    if (best) shortest.set(nodeId, best)
  }
  return shortest
}
