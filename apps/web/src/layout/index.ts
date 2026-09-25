import ELK, { type ElkNode } from 'elkjs/lib/elk-api.js'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import type { LayoutBox, LayoutNodeInput, LayoutRequest, LayoutResult } from './types'

export * from './types'

/**
 * ELK runs in its own Web Worker, so a 500-node layout never blocks the canvas.
 * `elk-api` + an explicit `workerFactory` is the supported bundler path;
 * `elk.bundled.js` cannot be used here because it detects a worker scope and
 * refuses to spawn its inner worker.
 */
const elk = new ELK({ workerFactory: () => new ElkWorker() })

/**
 * Every level uses ELK's rectpacking, tuned with an aspect ratio, so the result
 * reads like an AWS architecture diagram instead of a generic DAG.
 *
 * Layered layout is the wrong tool here: the containers have no edges between
 * them, so ELK falls back to connected-component packing and the AZ columns end
 * up stacked vertically no matter which `direction` is set. rectpacking honours
 * declaration order and a target aspect ratio, which gives exactly the
 * arrangement the design calls for:
 *
 *   ~0.1  → a single column (regions stacked, public subnet above private)
 *   ~10   → a single row    (AZ columns side by side)
 *   2–5   → wrapping rows   (resource tiles inside a subnet or lane)
 */
const COLUMN = '0.1'
const ROW = '10.0'

const ASPECT_BY_TYPE: Record<string, string> = {
  region: COLUMN, // regional-services lane above the VPC
  vpc: ROW, // AZ columns side by side
  az: COLUMN, // public subnet above private subnet
  subnet: '2.6', // tiles wrap into a block
  lane: '5.0', // global services as a wide strip
}

const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'rectpacking',
  // Global/edge lane on top, then one region per row.
  'elk.aspectRatio': COLUMN,
  'elk.spacing.nodeNode': '56',
  'elk.padding': '[top=28,left=28,bottom=28,right=28]',
}

function containerOptions(node: LayoutNodeInput): Record<string, string> {
  const type = node.containerType ?? ''
  return {
    'elk.algorithm': 'rectpacking',
    'elk.aspectRatio': ASPECT_BY_TYPE[type] ?? '2.6',
    'elk.spacing.nodeNode': type === 'subnet' || type === 'lane' ? '28' : '34',
    'elk.padding': `[top=${node.paddingTop},left=20,bottom=20,right=20]`,
  }
}

function buildTree(request: LayoutRequest): ElkNode {
  const byId = new Map<string, LayoutNodeInput>()
  for (const node of request.nodes) byId.set(node.id, node)

  const childrenOf = new Map<string | null, LayoutNodeInput[]>()
  for (const node of request.nodes) {
    // A node whose parent was filtered out is promoted to the root rather than
    // being dropped, so filtering never silently loses resources.
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null
    const list = childrenOf.get(parent)
    if (list) list.push(node)
    else childrenOf.set(parent, [node])
  }

  const toElk = (node: LayoutNodeInput): ElkNode => {
    const children = childrenOf.get(node.id) ?? []
    if (children.length === 0) {
      return { id: node.id, width: node.width, height: node.height }
    }
    return {
      id: node.id,
      layoutOptions: containerOptions(node),
      children: children.map(toElk),
    }
  }

  return {
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children: (childrenOf.get(null) ?? []).map(toElk),
    edges: request.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  }
}

function collect(node: ElkNode, boxes: Record<string, LayoutBox>): void {
  for (const child of node.children ?? []) {
    boxes[child.id] = {
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
    }
    collect(child, boxes)
  }
}

export async function layoutGraph(request: LayoutRequest): Promise<LayoutResult> {
  const laidOut = await elk.layout(buildTree(request))
  const boxes: Record<string, LayoutBox> = {}
  collect(laidOut, boxes)
  return { boxes, width: laidOut.width ?? 0, height: laidOut.height ?? 0 }
}
