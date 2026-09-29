import {
  INTERNET_NODE_ID,
  isContainerType,
  type ComplianceReport,
  type ComplianceResult,
  type ComplianceScope,
  type Graph,
  type GraphNode,
} from '@cloudatlas/shared'
import { CHECKS, buildCheckContext } from './checks.js'
import { FRAMEWORKS } from './frameworks.js'
import { fixFor, type FixContext } from './fixes.js'

export const OUTSIDE_VPC_SCOPE_ID = 'outside-vpc'

/**
 * Containers carry no configuration of their own, except the two that do: a
 * VPC has flow logs and a subnet has its public-IP default.
 */
function isAssessable(node: GraphNode): boolean {
  if (node.id === INTERNET_NODE_ID || node.type === 'internet') return false
  return !isContainerType(node.type) || node.type === 'vpc' || node.type === 'subnet'
}

/**
 * Measure a scan against every framework.
 *
 * Pure over the graph, like the posture detectors, so a replayed fixture and
 * the demo produce a report through exactly this code. Each resource is
 * evaluated once; scopes only say which resources they hold.
 */
export function evaluateCompliance(graph: Graph): ComplianceReport {
  const context = buildCheckContext(graph)
  const fixContext: FixContext = { ...context, profile: graph.profile, accountId: graph.accountId }
  const assessable = graph.nodes.filter(isAssessable)

  const results: ComplianceResult[] = []
  for (const node of assessable) {
    for (const check of CHECKS) {
      if (!check.applies(node)) continue
      const outcome = check.evaluate(node, context)
      const fix = outcome.status === 'fail' ? fixFor(check.id, node, fixContext) : undefined
      results.push({ checkId: check.id, nodeId: node.id, ...outcome, ...(fix ? { fix } : {}) })
    }
  }

  return {
    frameworks: FRAMEWORKS,
    checks: CHECKS.map(({ applies: _applies, evaluate: _evaluate, ...check }) => check),
    results,
    scopes: buildScopes(graph, assessable),
    scannedAt: graph.scannedAt,
  }
}

function buildScopes(graph: Graph, assessable: GraphNode[]): ComplianceScope[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  // Grouped by vpcId rather than by VPC node, so resources whose VPC could not
  // be described still land in a scope instead of silently in none.
  const byVpc = new Map<string, GraphNode[]>()
  const outside: GraphNode[] = []
  for (const node of assessable) {
    if (node.vpcId) {
      const list = byVpc.get(node.vpcId)
      if (list) list.push(node)
      else byVpc.set(node.vpcId, [node])
    } else {
      outside.push(node)
    }
  }
  const outsideIds = new Set(outside.map((node) => node.id))

  const scopes: ComplianceScope[] = []
  for (const [vpcId, members] of byVpc) {
    const memberIds = new Set(members.map((node) => node.id))

    // One hop out of the VPC: the bucket its tasks write to, the distribution
    // in front of its load balancer. Only resources outside every VPC are
    // pulled in — another VPC's resources are that VPC's scope.
    const connected = new Set<string>()
    for (const edge of graph.edges) {
      if (edge.kind === 'risk') continue
      if (memberIds.has(edge.source) && outsideIds.has(edge.target)) connected.add(edge.target)
      if (memberIds.has(edge.target) && outsideIds.has(edge.source)) connected.add(edge.source)
    }

    const vpc = nodeById.get(vpcId)
    scopes.push({
      id: vpcId,
      kind: 'vpc',
      name: vpc?.name ?? vpcId,
      region: vpc?.region ?? members[0]?.region ?? 'unknown',
      cidr: vpc?.cidr ?? null,
      nodeIds: members.map((node) => node.id),
      connectedNodeIds: [...connected].sort(),
    })
  }

  scopes.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name))

  if (outside.length > 0) {
    scopes.push({
      id: OUTSIDE_VPC_SCOPE_ID,
      kind: 'outside-vpc',
      name: 'Outside any VPC',
      region: 'global',
      cidr: null,
      nodeIds: outside.map((node) => node.id),
      connectedNodeIds: [],
    })
  }
  return scopes
}
