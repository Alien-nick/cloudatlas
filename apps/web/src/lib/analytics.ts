import { isContainerType, metricsFor, type Finding, type GraphNode } from '@cloudatlas/shared'

/**
 * Account-wide analytics, computed from the scanned graph.
 *
 * The organising idea is coverage rather than totals. "Analytics for all
 * resources" is only honest if it says which resources it could *not* analyse —
 * a dashboard reporting 100% healthy because it silently counted the 40% it
 * knows how to assess is the failure this whole tool exists to avoid.
 *
 * So every measure here carries its denominator, and the gaps are a first-class
 * output rather than a rounding error.
 */

export type CoverageKind = 'metrics' | 'logs' | 'health'

export interface Coverage {
  kind: CoverageKind
  label: string
  covered: number
  total: number
  /** Why the uncovered ones are uncovered, in the reader's terms. */
  gapReason: string
}

/** Resources, excluding containers and the synthetic internet node. */
export function realResources(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter((node) => !isContainerType(node.type) && node.type !== 'internet')
}

export function hasMetrics(node: GraphNode): boolean {
  return metricsFor(node.type).length > 0
}

export function hasLogs(node: GraphNode): boolean {
  return node.logGroups.length > 0
}

/** `unknown` means nothing assessed it, which is not the same as healthy. */
export function isAssessed(node: GraphNode): boolean {
  return node.health !== 'unknown'
}

export function coverage(nodes: GraphNode[]): Coverage[] {
  const resources = realResources(nodes)
  const total = resources.length
  return [
    {
      kind: 'metrics',
      label: 'CloudWatch metrics',
      covered: resources.filter(hasMetrics).length,
      total,
      gapReason: 'no metric catalog entry for this resource type',
    },
    {
      kind: 'logs',
      label: 'Log groups',
      covered: resources.filter(hasLogs).length,
      total,
      gapReason: 'no log group discovered for this resource',
    },
    {
      kind: 'health',
      label: 'Health assessed',
      covered: resources.filter(isAssessed).length,
      total,
      gapReason: 'nothing evaluated this resource, so its state is unknown',
    },
  ]
}

export interface Ranked {
  key: string
  label: string
  count: number
}

/** Counts by a key, largest first, with a stable tiebreak. */
export function rank(
  nodes: GraphNode[],
  by: (node: GraphNode) => string | null,
  labels?: (key: string) => string,
): Ranked[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const key = by(node)
    if (key === null) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labels?.(key) ?? key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export interface HealthBreakdown {
  state: 'critical' | 'warn' | 'ok' | 'unknown'
  label: string
  /** Paired with the colour so state is never carried by colour alone. */
  glyph: string
  count: number
}

export function healthBreakdown(nodes: GraphNode[]): HealthBreakdown[] {
  const resources = realResources(nodes)
  const counts = { critical: 0, warn: 0, ok: 0, unknown: 0 }
  for (const node of resources) counts[node.health] += 1

  return [
    { state: 'critical', label: 'Critical', glyph: '▲', count: counts.critical },
    { state: 'warn', label: 'Warning', glyph: '◆', count: counts.warn },
    { state: 'ok', label: 'Healthy', glyph: '●', count: counts.ok },
    // Listed even at zero: "unknown" going unmentioned is how a dashboard
    // implies everything was checked when it was not.
    { state: 'unknown', label: 'Not assessed', glyph: '○', count: counts.unknown },
  ]
}

/** Resources with neither metrics nor logs — genuinely unobservable here. */
export function blindSpots(nodes: GraphNode[]): GraphNode[] {
  return realResources(nodes)
    .filter((node) => !hasMetrics(node) && !hasLogs(node))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
}

export function findingsByKind(findings: Finding[]): Ranked[] {
  const counts = new Map<string, number>()
  for (const finding of findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key.replace(/-/g, ' '), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Percentage for display; 0 rather than NaN when there is nothing to divide. */
export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}
