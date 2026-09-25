import { isContainerType, type GraphNode } from '@cloudatlas/shared'

/**
 * Ranking for the ⌘K palette.
 *
 * Ranked rather than merely filtered. With a few hundred nodes, substring
 * matching alone buries the exact name you typed under every node that happens
 * to contain it — typing a full resource name and finding it third is the
 * failure that makes a palette useless. So an exact match sorts first, then a
 * prefix, then a name match, then id, type and tags.
 */

/** Higher is better. Null means no match at all. */
export function scoreNode(node: GraphNode, needle: string): number | null {
  if (needle.length === 0) return 0
  const name = node.name.toLowerCase()
  const id = node.id.toLowerCase()

  if (name === needle || id === needle) return 100
  if (name.startsWith(needle)) return 80
  if (name.includes(needle)) return 60
  if (id.includes(needle)) return 40
  if (node.type.includes(needle) || node.typeLabel.toLowerCase().includes(needle)) return 20
  if (node.tags.some((tag) => `${tag.key}=${tag.value}`.toLowerCase().includes(needle))) return 10
  return null
}

/**
 * Matching resources, best first.
 *
 * Containers are excluded: they are navigation, not destinations, and
 * selecting a VPC tells you nothing the canvas does not already show.
 */
export function rankResources(nodes: GraphNode[], query: string, limit = 20): GraphNode[] {
  const needle = query.trim().toLowerCase()
  const scored: Array<{ node: GraphNode; score: number }> = []

  for (const node of nodes) {
    if (isContainerType(node.type) || node.type === 'internet') continue
    const score = scoreNode(node, needle)
    if (score === null) continue
    scored.push({ node, score })
  }

  scored.sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
  return scored.slice(0, limit).map((entry) => entry.node)
}
