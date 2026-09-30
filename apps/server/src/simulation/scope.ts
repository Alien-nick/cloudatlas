import type { Graph, SimulationScope } from '@cloudatlas/shared'

/**
 * The part of a scan a simulation is about.
 *
 * A simulation of one VPC should not carry forty unrelated buckets and every
 * other network in the account: they clutter the canvas and dilute the impact
 * figures. The scope keeps the chosen VPCs whole, optionally the resources
 * outside any VPC, and the regions and lanes that hold them.
 */
export function scopeGraph(graph: Graph, scope: SimulationScope | null): Graph {
  if (!scope) return graph
  const vpcs = new Set(scope.vpcIds)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  const kept = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'region' || node.type === 'lane' || node.type === 'internet') continue
    if (node.vpcId ? vpcs.has(node.vpcId) : scope.includeOutside) kept.add(node.id)
  }
  // Every kept resource keeps the containers above it.
  for (const id of [...kept]) {
    let parent = byId.get(id)?.parentId ?? null
    while (parent && !kept.has(parent)) {
      kept.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
  }
  // The internet node stays only while something kept is exposed to it.
  const riskToKept = graph.edges.some((edge) => edge.kind === 'risk' && kept.has(edge.target))
  const internet = graph.nodes.find((node) => node.type === 'internet')
  if (internet && riskToKept) kept.add(internet.id)

  const regions = new Set(graph.nodes.filter((node) => kept.has(node.id)).map((node) => node.region))
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
    securityGroups: graph.securityGroups.filter((sg) => (sg.vpcId ? vpcs.has(sg.vpcId) : scope.includeOutside)),
    regions: graph.regions.filter((region) => regions.has(region.id)),
  }
}
