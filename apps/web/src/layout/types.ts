export interface LayoutNodeInput {
  id: string
  parentId: string | null
  width: number
  height: number
  /** Extra top padding inside a container, reserving room for its label. */
  paddingTop: number
  isContainer: boolean
  /** Container kind ("region" | "vpc" | "az" | "subnet" | "lane"), if any. */
  containerType?: string
}

export interface LayoutEdgeInput {
  id: string
  source: string
  target: string
}

export interface LayoutRequest {
  nodes: LayoutNodeInput[]
  edges: LayoutEdgeInput[]
}

export interface LayoutBox {
  /** Relative to the parent container, as Vue Flow expects for child nodes. */
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  boxes: Record<string, LayoutBox>
  /** Overall content size, used to fit the view. */
  width: number
  height: number
}

