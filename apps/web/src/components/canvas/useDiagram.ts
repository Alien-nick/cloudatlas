import { isContainerType, type Finding, type GraphEdge, type GraphNode } from '@cloudatlas/shared'
import { layoutGraph, type LayoutBox, type LayoutEdgeInput, type LayoutNodeInput } from '@/layout'
import {
  COLLAPSED_HEIGHT,
  COLLAPSED_WIDTH,
  CONTAINER_PADDING_TOP,
  RESOURCE_HEIGHT,
  RESOURCE_WIDTH,
  type ContainerNodeData,
  type ResourceNodeData,
} from './nodeData'

export interface FlowNode {
  id: string
  type: 'resource' | 'container'
  position: { x: number; y: number }
  parentNode?: string
  parentId?: string
  draggable: false
  selectable: boolean
  focusable: boolean
  zIndex: number
  class?: string
  style: Record<string, string>
  data: ResourceNodeData | ContainerNodeData
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  type: 'smoothstep'
  animated: boolean
  zIndex: number
  label?: string
  labelBgPadding?: [number, number]
  labelBgBorderRadius?: number
  labelStyle?: Record<string, string>
  labelBgStyle?: Record<string, string>
  style: Record<string, string | number>
  data: { kind: GraphEdge['kind'] }
}

interface PlacedEdge {
  edge: GraphEdge
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
}

/**
 * Geometry only. Produced by ELK and reused across hover, selection and
 * theme changes — those restyle the diagram but must never move it.
 */
export interface DiagramLayout {
  boxes: Record<string, LayoutBox>
  /** Parents before children, as Vue Flow requires for compound nodes. */
  ordered: GraphNode[]
  hidden: Set<string>
  depth: Map<string, number>
  descendantCount: Map<string, number>
  edges: PlacedEdge[]
  collapsed: Set<string>
  width: number
  height: number
}

export interface DecorateOptions {
  findingsByNode: Map<string, Finding[]>
  selectedId: string | null
  highlightedIds: Set<string> | null
  showEdgeLabels: boolean
  securityView: boolean
}

const EDGE_COLORS: Record<GraphEdge['kind'], string> = {
  traffic: 'var(--ca-edge)',
  sg: '#6b7480',
  event: '#E7157B',
  risk: '#f2555a',
}

const EDGE_DASH: Record<GraphEdge['kind'], string> = {
  traffic: '0',
  sg: '6 5',
  event: '2 5',
  risk: '6 4',
}

/** Containers the user is allowed to fold away. */
function isCollapsible(node: GraphNode): boolean {
  return node.type === 'vpc'
}

function worstSeverity(findings: Finding[]): 'critical' | 'warning' | null {
  if (findings.length === 0) return null
  return findings.some((f) => f.severity === 'critical') ? 'critical' : 'warning'
}

// ---------------------------------------------------------------------------
// Stage 1 — layout (async, off the main thread)
// ---------------------------------------------------------------------------

export async function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  collapsed: Set<string>,
): Promise<DiagramLayout> {
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // Everything inside a collapsed container is hidden, and its edges are
  // re-pointed at the container so the connection stays visible.
  const hidden = new Set<string>()
  const collapseRoot = new Map<string, string>()
  for (const node of nodes) {
    let ancestor = node.parentId
    while (ancestor) {
      if (collapsed.has(ancestor)) {
        hidden.add(node.id)
        collapseRoot.set(node.id, ancestor)
        break
      }
      ancestor = byId.get(ancestor)?.parentId ?? null
    }
  }
  const resolveId = (id: string): string => collapseRoot.get(id) ?? id
  const visible = nodes.filter((n) => !hidden.has(n.id))

  const descendantCount = new Map<string, number>()
  for (const node of nodes) {
    if (isContainerType(node.type)) continue
    let ancestor = node.parentId
    while (ancestor) {
      descendantCount.set(ancestor, (descendantCount.get(ancestor) ?? 0) + 1)
      ancestor = byId.get(ancestor)?.parentId ?? null
    }
  }

  const layoutNodes: LayoutNodeInput[] = visible.map((node) => {
    const isCollapsed = collapsed.has(node.id)
    const container = isContainerType(node.type) && !isCollapsed
    return {
      id: node.id,
      parentId: node.parentId,
      width: isCollapsed ? COLLAPSED_WIDTH : RESOURCE_WIDTH,
      height: isCollapsed ? COLLAPSED_HEIGHT : RESOURCE_HEIGHT,
      paddingTop: CONTAINER_PADDING_TOP[node.type] ?? 32,
      isContainer: container,
      ...(container ? { containerType: node.type } : {}),
    }
  })

  const seen = new Set<string>()
  const layoutEdges: LayoutEdgeInput[] = []
  const remapped: Array<{ edge: GraphEdge; source: string; target: string }> = []
  for (const edge of edges) {
    const source = resolveId(edge.source)
    const target = resolveId(edge.target)
    if (source === target) continue
    const key = `${source}->${target}:${edge.kind}:${edge.label ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    layoutEdges.push({ id: edge.id, source, target })
    remapped.push({ edge, source, target })
  }

  const layout = await layoutGraph({ nodes: layoutNodes, edges: layoutEdges })

  // Absolute rectangles, needed to pick which face each edge leaves from.
  const absolute = new Map<string, { x: number; y: number; w: number; h: number }>()
  const depth = new Map<string, number>()

  const place = (node: GraphNode): { x: number; y: number; w: number; h: number } => {
    const cached = absolute.get(node.id)
    if (cached) return cached
    const box = layout.boxes[node.id] ?? { x: 0, y: 0, width: 0, height: 0 }
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const parentRect =
      parent && !hidden.has(parent.id) ? place(parent) : { x: 0, y: 0, w: 0, h: 0 }
    const rect = {
      x: parentRect.x + box.x,
      y: parentRect.y + box.y,
      w: box.width,
      h: box.height,
    }
    absolute.set(node.id, rect)
    depth.set(node.id, parent && !hidden.has(parent.id) ? (depth.get(parent.id) ?? 0) + 1 : 0)
    return rect
  }
  for (const node of visible) place(node)

  const placedEdges: PlacedEdge[] = remapped.map(({ edge, source, target }) => {
    const a = absolute.get(source)
    const b = absolute.get(target)
    const dx = a && b ? b.x + b.w / 2 - (a.x + a.w / 2) : 0
    const dy = a && b ? b.y + b.h / 2 - (a.y + a.h / 2) : 1
    // Dominant-axis routing, matching the design's bezier choice.
    const vertical = Math.abs(dy) >= Math.abs(dx)
    return {
      edge,
      source,
      target,
      sourceHandle: vertical ? (dy >= 0 ? 'b-src' : 't-src') : dx >= 0 ? 'r-src' : 'l-src',
      targetHandle: vertical ? (dy >= 0 ? 't-tgt' : 'b-tgt') : dx >= 0 ? 'l-tgt' : 'r-tgt',
    }
  })

  const ordered = [...visible].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))

  return {
    boxes: layout.boxes,
    ordered,
    hidden,
    depth,
    descendantCount,
    edges: placedEdges,
    collapsed,
    width: layout.width,
    height: layout.height,
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — decoration (synchronous, runs on every hover/selection change)
// ---------------------------------------------------------------------------

export function decorate(
  layout: DiagramLayout,
  options: DecorateOptions,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = layout.ordered.map((node) => {
    const box = layout.boxes[node.id] ?? {
      x: 0,
      y: 0,
      width: RESOURCE_WIDTH,
      height: RESOURCE_HEIGHT,
    }
    const isCollapsed = layout.collapsed.has(node.id)
    const isContainer = isContainerType(node.type) && !isCollapsed
    const depth = layout.depth.get(node.id) ?? 0
    const findings = options.findingsByNode.get(node.id) ?? []
    const dimmed = options.highlightedIds !== null && !options.highlightedIds.has(node.id)

    const data: ResourceNodeData | ContainerNodeData =
      isContainer || isCollapsed
        ? {
            node,
            resourceCount: layout.descendantCount.get(node.id) ?? 0,
            collapsed: isCollapsed,
            collapsible: isCollapsible(node),
          }
        : {
            node,
            dimmed,
            selected: options.selectedId === node.id,
            findingCount: findings.length,
            worstSeverity: worstSeverity(findings),
          }

    const hasParent = node.parentId !== null && !layout.hidden.has(node.parentId)

    return {
      id: node.id,
      type: isContainer || isCollapsed ? 'container' : 'resource',
      position: { x: box.x, y: box.y },
      ...(hasParent && node.parentId
        ? { parentNode: node.parentId, parentId: node.parentId }
        : {}),
      draggable: false,
      selectable: !isContainer,
      focusable: !isContainer,
      zIndex: isContainer ? depth : 100 + depth,
      ...(isContainer || isCollapsed ? { class: 'ca-container-node' } : {}),
      style: { width: `${box.width}px`, height: `${box.height}px` },
      data,
    }
  })

  const edges: FlowEdge[] = layout.edges.map(({ edge, source, target, sourceHandle, targetHandle }) => {
    const active =
      options.highlightedIds !== null &&
      options.highlightedIds.has(source) &&
      options.highlightedIds.has(target)
    const dimmed = options.highlightedIds !== null && !active
    const isRisk = edge.kind === 'risk'
    const color = edge.kind === 'sg' && options.securityView ? '#8C4FFF' : EDGE_COLORS[edge.kind]
    const showLabel = options.showEdgeLabels && Boolean(edge.label)

    return {
      id: edge.id,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      animated: false,
      zIndex: 50,
      ...(showLabel
        ? {
            label: edge.label,
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
            labelStyle: {
              fill: isRisk ? '#f2555a' : 'var(--ca-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
            },
            labelBgStyle: {
              fill: isRisk ? 'rgba(242,85,90,.16)' : 'var(--ca-panel)',
              stroke: isRisk ? '#f2555a' : 'var(--ca-border2)',
            },
          }
        : {}),
      style: {
        // Inline as well as in Vue Flow's stylesheet: export copies styles
        // element by element, and an SVG path with no fill is filled black.
        fill: 'none',
        stroke: color,
        strokeWidth: isRisk ? 2 : active ? 2 : 1.3,
        strokeDasharray: EDGE_DASH[edge.kind],
        opacity: dimmed ? 0.08 : isRisk ? 0.95 : 0.6,
      },
      data: { kind: edge.kind },
    }
  })

  return { nodes, edges }
}
