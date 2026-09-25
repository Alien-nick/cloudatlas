import type { GraphNode } from '@cloudatlas/shared'

export interface ResourceNodeData {
  node: GraphNode
  /** Faded because the hovered node is not adjacent to it. */
  dimmed: boolean
  selected: boolean
  /** Number of open findings; drives the badge pill. */
  findingCount: number
  worstSeverity: 'critical' | 'warning' | null
}

export interface ContainerNodeData {
  node: GraphNode
  /** Resources inside, including nested containers' contents. */
  resourceCount: number
  collapsed: boolean
  collapsible: boolean
}

/** Leaf tile footprint. Matches the design's 104px column plus breathing room. */
export const RESOURCE_WIDTH = 116
export const RESOURCE_HEIGHT = 80

/** Footprint of a collapsed VPC, which becomes a summary tile. */
export const COLLAPSED_WIDTH = 230
export const COLLAPSED_HEIGHT = 92

/** Top padding per container type, reserving room for the label row. */
export const CONTAINER_PADDING_TOP: Record<string, number> = {
  region: 46,
  vpc: 46,
  az: 38,
  subnet: 36,
  lane: 34,
}
