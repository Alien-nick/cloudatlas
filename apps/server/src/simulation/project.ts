import type { Graph } from '@cloudatlas/shared'
import { laneId, node, regionId } from '../graph/helpers.js'

/** Projects belong to no scanned account; this marks their empty snapshot. */
export const PROJECT_ACCOUNT = 'project'

/**
 * The snapshot a project starts from: nothing but the region it is designed
 * in, so the canvas has somewhere to drop the first resource. Everything
 * after is the change log, exactly as in a simulation.
 */
export function emptyGraph(region: string, profile: string, now = Date.now()): Graph {
  const regionNode = node({
    id: regionId(region),
    type: 'region',
    category: 'network',
    name: `Region · ${region}`,
    abbr: 'R',
    typeLabel: 'AWS Region',
    region,
    parentId: null,
    state: 'active',
    raw: {},
  })
  const lane = node({
    id: laneId(region),
    type: 'lane',
    category: 'network',
    name: 'Regional services',
    abbr: 'G',
    typeLabel: 'Service lane',
    region,
    parentId: regionNode.id,
    state: 'active',
    raw: {},
  })
  return {
    nodes: [regionNode, lane],
    edges: [],
    securityGroups: [],
    regions: [{ id: region, count: 0 }],
    missingPermissions: [],
    collectorFailures: [],
    scannedAt: now,
    accountId: PROJECT_ACCOUNT,
    accountAlias: null,
    profile,
  }
}
