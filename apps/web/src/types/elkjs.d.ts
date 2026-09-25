/**
 * elkjs ships its browser builds without type declarations. Only the small
 * surface CloudAtlas uses is declared here.
 */
declare module 'elkjs/lib/elk-api.js' {
  export interface ElkPoint {
    x: number
    y: number
  }

  export interface ElkExtendedEdge {
    id: string
    sources: string[]
    targets: string[]
  }

  export interface ElkNode {
    id: string
    x?: number
    y?: number
    width?: number
    height?: number
    children?: ElkNode[]
    edges?: ElkExtendedEdge[]
    layoutOptions?: Record<string, string>
  }

  export interface ElkConstructorOptions {
    /** Returns the Worker that runs the layout algorithm. */
    workerFactory?: (url: string | undefined) => Worker
    workerUrl?: string
    defaultLayoutOptions?: Record<string, string>
  }

  export default class ELK {
    constructor(options?: ElkConstructorOptions)
    layout(graph: ElkNode, options?: { layoutOptions?: Record<string, string> }): Promise<ElkNode>
    terminateWorker(): void
  }
}

declare module 'elkjs/lib/elk-worker.min.js?worker' {
  const WorkerConstructor: new () => Worker
  export default WorkerConstructor
}
