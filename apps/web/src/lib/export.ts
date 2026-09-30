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

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The box to export: every rect, plus padding. Null when there is nothing.
 */
export function boundsOf(rects: Rect[]): Bounds | null {
  if (rects.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  }
}

/**
 * Bounding box of the diagram as drawn, in flow coordinates.
 *
 * Measured from the rendered node elements rather than from Vue Flow's node
 * data. The data was the first choice and was wrong twice: `position` is
 * relative to the parent container in a compound layout, and even the
 * computed absolute positions and dimensions described a box more than twice
 * the size of what was on screen — leaving the diagram in one corner of a
 * mostly empty image. What is rendered is, by definition, what the export
 * should contain.
 *
 * Measuring the DOM rather than the viewport also still covers the whole
 * diagram: nodes outside the visible area are rendered, just off screen.
 *
 * `pane` is the element carrying the live pan and zoom, so dividing by its
 * scale turns screen pixels back into flow units whatever the zoom is.
 */
export function renderedBounds(pane: HTMLElement): Bounds | null {
  const transform = getComputedStyle(pane).transform
  const zoom = (transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).a : 1) || 1
  const origin = pane.getBoundingClientRect()
  const rects = [...pane.querySelectorAll<HTMLElement>('.vue-flow__node')]
    .filter((element) => element.offsetParent !== null)
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: (rect.left - origin.left) / zoom,
        y: (rect.top - origin.top) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      }
    })
    .filter((rect) => rect.width > 0 && rect.height > 0)
  return boundsOf(rects)
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
  /**
   * The `.vue-flow__transformationpane` element: the one holding nodes and
   * edges in flow coordinates, and carrying the live pan and zoom. Not
   * `.vue-flow__viewport`, which is its untransformed container — exporting
   * that inherited whatever zoom the canvas was at, so a zoomed-out canvas
   * exported shrunk and cut off.
   */
  pane: HTMLElement
  bounds: Bounds
  filename: string
  /** Page background, so the image is not transparent where nothing is drawn. */
  background: string
  /** Multiplier for PNG resolution. */
  scale?: number
}

/**
 * Capture the whole diagram, framed on its bounds rather than on whatever is
 * currently on screen.
 */
async function capture(
  options: ExportOptions,
  render: (element: HTMLElement, config: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const { pane, bounds, background } = options

  // The clone's transform replaces the live pan and zoom entirely, framing
  // the diagram at 1:1 on its bounds; the live canvas never moves. The origin
  // is stated explicitly: scaling about the centre shifted the diagram off the
  // top-left and cropped it.
  //
  // Resolution comes from `pixelRatio`, which scales the output canvas. A CSS
  // scale() on the clone did not take effect, leaving the diagram in one
  // corner of an image twice its size.
  return render(pane, {
    backgroundColor: background,
    width: bounds.width,
    height: bounds.height,
    pixelRatio: options.scale ?? 1,
    style: {
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      transform: `translate(${-bounds.x}px, ${-bounds.y}px)`,
      transformOrigin: '0 0',
    },
    // The minimap and the toolbar are chrome, not diagram. So is each
    // edge's interaction path: a wide invisible stroke that exists only to
    // be clicked, which the export would otherwise draw as a black fill.
    filter: (node: HTMLElement) =>
      !node.classList?.contains('vue-flow__minimap') &&
      !node.classList?.contains('vue-flow__panel') &&
      !node.classList?.contains('vue-flow__edge-interaction'),
  })
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
