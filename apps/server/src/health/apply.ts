import {
  isContainerType,
  isPostureFinding,
  metricsFor,
  type Finding,
  type GraphNode,
  type Health,
} from '@cloudatlas/shared'

/**
 * Roll findings up onto the nodes so the canvas can badge them.
 *
 * A posture finding never escalates a node past `warn`, however severe the
 * finding itself is. A publicly accessible database is serious and sorts to the
 * top of the Posture list, but it is a misconfiguration, not an outage — and a
 * red ring on the diagram should mean "this is broken right now".
 *
 * Containers are never badged: a red VPC tells you nothing about which resource
 * inside it is unhappy.
 */
export function applyHealth(nodes: GraphNode[], findings: Finding[]): void {
  const worst = new Map<string, Health>()

  for (const finding of findings) {
    if (isPostureFinding(finding.kind)) {
      if (worst.get(finding.nodeId) !== 'critical') worst.set(finding.nodeId, 'warn')
      continue
    }
    if (finding.severity === 'critical') worst.set(finding.nodeId, 'critical')
    else if (worst.get(finding.nodeId) !== 'critical') worst.set(finding.nodeId, 'warn')
  }

  for (const node of nodes) {
    if (isContainerType(node.type) || node.type === 'internet') continue
    // `unknown` rather than `ok` for a type we have no way to assess, so a
    // green badge always means something was actually checked.
    node.health = worst.get(node.id) ?? (metricsFor(node.type).length > 0 ? 'ok' : 'unknown')
  }
}
