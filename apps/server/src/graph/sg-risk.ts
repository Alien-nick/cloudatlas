import {
  INTERNET_NODE_ID,
  SENSITIVE_PORTS,
  WORLD_CIDRS,
  type Finding,
  type GraphEdge,
  type GraphNode,
  type SecurityGroup,
  type SecurityGroupRule,
} from '@cloudatlas/shared'

function isWorld(source: string): boolean {
  return WORLD_CIDRS.includes(source)
}

function coveredSensitivePorts(rule: SecurityGroupRule): string[] {
  // A protocol of "-1"/"all" with no port bounds means every port.
  const allPorts = rule.fromPort === null && rule.toPort === null
  if (allPorts) return Object.entries(SENSITIVE_PORTS).map(([p, name]) => `${p} (${name})`)

  const from = rule.fromPort ?? 0
  const to = rule.toPort ?? from
  const hits: string[] = []
  for (const [portStr, name] of Object.entries(SENSITIVE_PORTS)) {
    const port = Number(portStr)
    if (port >= from && port <= to) hits.push(`${port} (${name})`)
  }
  return hits
}

export interface SgAnalysis {
  /** Copy of the input with `risky` set on offending rules. */
  securityGroups: SecurityGroup[]
  /** internet -> resource edges, one per resource behind a risky rule. */
  riskEdges: GraphEdge[]
  /** resource -> resource edges derived from SG-to-SG references. */
  sgEdges: GraphEdge[]
  findings: Finding[]
}

/**
 * Derives the security layer of the graph: which groups expose sensitive ports
 * to the internet, and which groups reference each other (the "app tier talks
 * to the database" relationship that describe output does not state directly).
 */
export function analyzeSecurityGroups(
  securityGroups: SecurityGroup[],
  nodes: GraphNode[],
  now: number,
): SgAnalysis {
  const nodesBySg = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    for (const sgId of node.securityGroupIds) {
      const list = nodesBySg.get(sgId)
      if (list) list.push(node)
      else nodesBySg.set(sgId, [node])
    }
  }

  const sgByName = new Map<string, SecurityGroup>()
  const sgById = new Map<string, SecurityGroup>()
  for (const sg of securityGroups) {
    sgById.set(sg.id, sg)
    sgByName.set(sg.name, sg)
  }

  const analyzed: SecurityGroup[] = []
  const riskEdges: GraphEdge[] = []
  const sgEdges: GraphEdge[] = []
  const findings: Finding[] = []
  const seenSgEdge = new Set<string>()

  for (const sg of securityGroups) {
    const rules: SecurityGroupRule[] = []

    for (const rule of sg.rules) {
      if (rule.direction !== 'in') {
        rules.push(rule)
        continue
      }

      // --- risky-to-the-world rules ---
      if (isWorld(rule.source)) {
        const sensitive = coveredSensitivePorts(rule)
        if (sensitive.length > 0) {
          rules.push({ ...rule, risky: true })
          const affected = nodesBySg.get(sg.id) ?? []
          const portLabel = rule.fromPort === null ? 'all' : rule.port
          for (const node of affected) {
            riskEdges.push({
              id: `risk:${INTERNET_NODE_ID}->${node.id}:${sg.id}:${rule.port}`,
              source: INTERNET_NODE_ID,
              target: node.id,
              kind: 'risk',
              label: portLabel,
              meta: { securityGroupId: sg.id, source: rule.source },
            })
            findings.push({
              id: `risky-sg:${sg.id}:${rule.protocol}:${rule.port}:${node.id}`,
              nodeId: node.id,
              severity: 'warning',
              kind: 'risky-sg-rule',
              title: `${sg.name} exposes ${sensitive[0] ?? rule.port} to the internet`,
              detail:
                `Security group ${sg.name} (${sg.id}) allows inbound ${rule.protocol}/${portLabel} ` +
                `from ${rule.source}. Sensitive ports reachable: ${sensitive.join(', ')}.`,
              metric: null,
              startedAt: now,
              endedAt: null,
              evidence: [
                `Rule: inbound ${rule.protocol}/${portLabel} from ${rule.source}`,
                `Group: ${sg.name} (${sg.id})`,
                `Attached to: ${affected.map((n) => n.name).join(', ')}`,
              ],
              sparkline: [],
              logGroups: [],
            })
          }
          continue
        }
        rules.push(rule)
        continue
      }

      // --- SG-to-SG references become application-tier edges ---
      const referenced = sgById.get(rule.source) ?? sgByName.get(rule.source)
      rules.push(rule)
      if (!referenced) continue

      const targets = nodesBySg.get(sg.id) ?? []
      const sources = nodesBySg.get(referenced.id) ?? []
      for (const from of sources) {
        for (const to of targets) {
          if (from.id === to.id) continue
          const key = `${from.id}->${to.id}:${rule.port}`
          if (seenSgEdge.has(key)) continue
          seenSgEdge.add(key)
          sgEdges.push({
            id: `sg:${key}`,
            source: from.id,
            target: to.id,
            kind: 'sg',
            label: rule.port,
            meta: { securityGroupId: sg.id, via: referenced.id },
          })
        }
      }
    }

    analyzed.push({ ...sg, rules })
  }

  return { securityGroups: analyzed, riskEdges, sgEdges, findings }
}

export const __testing = { coveredSensitivePorts, isWorld }
