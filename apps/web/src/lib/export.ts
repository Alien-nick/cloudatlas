import { toPng, toSvg } from 'html-to-image'
import type { GraphNode } from '@cloudatlas/shared'

/**
 * Diagram export.
 *
 * Vue Flow renders to DOM rather than to a canvas, so export means serialising
 * the rendered subtree. Two consequences shape this:
 *
 *  - The viewport is transformed and clipped, so exporting it as-is captures
 *    whatever happens to be on screen at the current zoom. The transform is
 *    overridden for the duration of the capture so the whole diagram is in
 *    frame regardless of where the user was panned to.
 *  - Fonts and colours come from CSS custom properties, which are resolved at
 *    capture time — so an export taken in dark mode is a dark image. That is
 *    intended; the alternative is an image that does not match what was on
 *    screen when it was taken.
 */

/** Padding around the diagram bounds, in flow units. */
const PADDING = 40

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Bounding box of the rendered nodes.
 *
 * Measured from the node positions rather than from the viewport, because the
 * viewport only knows what is currently visible.
 */
export function diagramBounds(
  nodes: Array<{ position: { x: number; y: number }; dimensions?: { width: number; height: number } }>,
): Bounds | null {
  if (nodes.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const node of nodes) {
    const width = node.dimensions?.width ?? 0
    const height = node.dimensions?.height ?? 0
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + width)
    maxY = Math.max(maxY, node.position.y + height)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  }
}

/** `cortex-prod-us-east-1-2026-09-23.png` */
export function exportFilename(
  account: string,
  regions: string[],
  format: 'png' | 'svg',
  now = new Date(),
): string {
  const date = now.toISOString().slice(0, 10)
  const scope = regions.length === 1 ? regions[0] : `${regions.length}-regions`
  const safe = `${account}-${scope}-${date}`.replace(/[^a-zA-Z0-9._-]/g, '-')
  return `${safe}.${format}`
}

function download(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.download = filename
  link.href = dataUrl
  link.click()
}

export interface ExportOptions {
  /** The `.vue-flow__viewport` element. */
  viewport: HTMLElement
  bounds: Bounds
  filename: string
  /** Page background, so the image is not transparent where nothing is drawn. */
  background: string
  /** Multiplier for PNG resolution. */
  scale?: number
}

/**
 * Capture with the viewport transform overridden.
 *
 * Restoring the original transform in a `finally` matters: throwing partway
 * through would otherwise leave the diagram frozen at the export framing, which
 * looks like the canvas broke.
 */
async function capture(
  options: ExportOptions,
  render: (element: HTMLElement, config: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const { viewport, bounds, background } = options
  const scale = options.scale ?? 1
  const previous = viewport.style.transform

  viewport.style.transform = `translate(${-bounds.x * scale}px, ${-bounds.y * scale}px) scale(${scale})`
  try {
    return await render(viewport, {
      backgroundColor: background,
      width: bounds.width * scale,
      height: bounds.height * scale,
      style: { width: `${bounds.width * scale}px`, height: `${bounds.height * scale}px` },
      // The minimap and the toolbar are chrome, not diagram.
      filter: (node: HTMLElement) =>
        !node.classList?.contains('vue-flow__minimap') &&
        !node.classList?.contains('vue-flow__panel'),
    })
  } finally {
    viewport.style.transform = previous
  }
}

export async function exportPng(options: ExportOptions): Promise<void> {
  // 2x by default: a diagram pasted into a document or an incident review is
  // usually being read, not just glanced at.
  const dataUrl = await capture({ ...options, scale: options.scale ?? 2 }, (element, config) =>
    toPng(element, config),
  )
  download(dataUrl, options.filename)
}

export async function exportSvg(options: ExportOptions): Promise<void> {
  const dataUrl = await capture({ ...options, scale: 1 }, (element, config) =>
    toSvg(element, config),
  )
  download(dataUrl, options.filename)
}

/** Node count, for the "exported N resources" confirmation. */
export function exportableCount(nodes: GraphNode[]): number {
  return nodes.length
}
