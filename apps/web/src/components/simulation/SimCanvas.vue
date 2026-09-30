<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { SIM_CATALOG, catalogEntry, type SimResourceType } from '@cloudatlas/shared'
import { Panel, VueFlow, useVueFlow, type NodeMouseEvent, type OnConnectStartParams } from '@vue-flow/core'
import { useSimulationStore } from '@/stores/simulation'
import { SIM_DRAG_TYPE, defaultPort, dropsInto, placeResource } from '@/lib/simPlacement'
import ContainerNode from '../canvas/ContainerNode.vue'
import ResourceNode from '../canvas/ResourceNode.vue'
import { computeLayout, decorate, type DiagramLayout, type FlowEdge, type FlowNode } from '../canvas/useDiagram'

/**
 * The simulated diagram: the same layout and tiles as the live canvas, fed by
 * the simulation instead of the scan, with added and changed resources tagged.
 * Its own Vue Flow instance, so panning here never moves the real diagram.
 *
 * Built to be worked in directly: drop resources from the palette where they
 * should go, drag from one resource to another to connect them, and watch the
 * diagram glide to its new shape rather than jump.
 */

const sim = useSimulationStore()
const FLOW_ID = 'simulation'
const { fitView, zoomIn, zoomOut, onNodesInitialized, findNode, setCenter, getViewport } = useVueFlow(FLOW_ID)

const layout = shallowRef<DiagramLayout | null>(null)
const nodes = shallowRef<FlowNode[]>([])
const edges = shallowRef<FlowEdge[]>([])
const collapsed = ref(new Set<string>())
const error = ref<string | null>(null)
let generation = 0
let fitPending = true

const graph = computed(() => sim.current?.graph ?? null)
const structureKey = computed(
  () =>
    `${graph.value?.nodes.map((n) => n.id).join('|')}##${graph.value?.edges.map((e) => e.id).join('|')}##${[...collapsed.value].join('|')}`,
)

async function relayout(): Promise<void> {
  const current = graph.value
  const token = ++generation
  if (!current) return
  try {
    const next = await computeLayout(current.nodes, current.edges, collapsed.value)
    if (token !== generation) return
    layout.value = next
    restyle(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

// ---------------------------------------------------------------------------
// Styling, and gliding between layouts
// ---------------------------------------------------------------------------

interface Frame {
  x: number
  y: number
  width: number | null
  height: number | null
}

/** Where each node was last drawn, relative to its parent: the start of the next glide. */
let drawn = new Map<string, Frame>()
let animation: number | null = null
const GLIDE_MS = 320

function frameOf(node: FlowNode): Frame {
  const style = (node.style ?? {}) as Record<string, string>
  return {
    x: node.position.x,
    y: node.position.y,
    width: style.width ? parseFloat(style.width) : null,
    height: style.height ? parseFloat(style.height) : null,
  }
}

function classesFor(node: FlowNode): string {
  const source = graph.value?.nodes.find((candidate) => candidate.id === node.id)
  return [
    node.id === sim.justAdded ? 'ca-sim-pulse' : '',
    node.id === dropTarget.value ? 'ca-sim-drop' : '',
    droppable.value && source && droppable.value.has(source.type) ? 'ca-sim-droppable' : '',
    node.type === 'container' && node.id === sim.selectedId ? 'ca-sim-selected' : '',
    node.id === connectFrom.value ? 'ca-sim-connect-from' : '',
    connectFrom.value && node.id === connectOver.value ? 'ca-sim-connect-to' : '',
    drawn.size > 0 && !drawn.has(node.id) ? 'ca-sim-enter' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function restyle(glide = false): void {
  if (!layout.value) return
  const result = decorate(layout.value, {
    findingsByNode: new Map(),
    selectedId: sim.selectedId,
    highlightedIds: null,
    showEdgeLabels: true,
    securityView: false,
    simStatus: sim.current?.status ?? {},
  })
  // Always set, even empty: Vue Flow merges node updates, so a class left
  // off would keep the previous one and old highlights would linger.
  const target = result.nodes.map((node) => ({ ...node, class: classesFor(node) }))
  edges.value = result.edges

  const from = drawn
  const moves = glide && from.size > 0 && target.some((node) => {
    const was = from.get(node.id)
    return was && (was.x !== node.position.x || was.y !== node.position.y)
  })
  if (animation !== null) cancelAnimationFrame(animation)
  if (!moves) {
    show(target)
    return
  }

  // Tween every node — containers grow, siblings slide aside — so a new
  // resource arrives in a diagram that makes room for it. Positions are
  // relative to the parent, which moves too, so the tween composes.
  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / GLIDE_MS)
    const ease = 1 - (1 - t) ** 3
    const lerp = (a: number, b: number) => a + (b - a) * ease
    const frame = target.map((node) => {
      const was = from.get(node.id)
      if (!was) return node
      const to = frameOf(node)
      const style = { ...(node.style as Record<string, string>) }
      if (was.width !== null && to.width !== null) style.width = `${lerp(was.width, to.width)}px`
      if (was.height !== null && to.height !== null) style.height = `${lerp(was.height, to.height)}px`
      return { ...node, position: { x: lerp(was.x, to.x), y: lerp(was.y, to.y) }, style }
    })
    if (t < 1) {
      nodes.value = frame
      animation = requestAnimationFrame(step)
    } else {
      animation = null
      show(target)
    }
  }
  animation = requestAnimationFrame(step)
}

function show(next: FlowNode[]): void {
  nodes.value = next
  drawn = new Map(next.map((node) => [node.id, frameOf(node)]))
  if (pendingFocus) flyTo(pendingFocus)
}

// Layout follows structure; a settings edit that changes no node or edge only restyles.
watch(structureKey, () => void relayout(), { immediate: true })
watch(() => [sim.selectedId, sim.current?.status, sim.justAdded] as const, () => restyle())
onBeforeUnmount(() => {
  if (animation !== null) cancelAnimationFrame(animation)
})

onNodesInitialized(() => {
  if (!fitPending) return
  fitPending = false
  void fitView({ padding: 0.12, duration: 300 })
})

// ---------------------------------------------------------------------------
// Focus: pan to a node the moment it exists, so a new resource is never lost
// ---------------------------------------------------------------------------

let pendingFocus: string | null = null

function flyTo(id: string, attempt = 0): void {
  if (animation !== null) return // the glide's last frame calls again
  const node = findNode(id)
  const width = node?.dimensions.width ?? 0
  if (!node || width === 0) {
    // Not rendered yet: the layout runs in a worker and Vue Flow measures
    // after paint. A few frames is always enough.
    if (attempt < 20) window.setTimeout(() => flyTo(id, attempt + 1), 50)
    return
  }
  pendingFocus = null
  const { x, y } = node.computedPosition
  const zoom = Math.max(getViewport().zoom, node.type === 'container' ? 0.6 : 0.9)
  void setCenter(x + width / 2, y + node.dimensions.height / 2, { zoom, duration: 500 })
}

watch(
  () => sim.focusRequest,
  (request) => {
    if (!request) return
    pendingFocus = request.id
    flyTo(request.id)
  },
)

// ---------------------------------------------------------------------------
// Drop from the palette
// ---------------------------------------------------------------------------

/** The container the dragged item would actually land in — not just what is under the pointer. */
const dropTarget = ref<string | null>(null)
const hovered = ref<string | null>(null)
/** Node types the dragged item may go into, lit up while dragging. */
const droppable = computed(() => (sim.draggingType ? dropsInto(sim.draggingType) : null))
watch(droppable, () => restyle())

/** The innermost diagram node under the pointer: nested nodes paint above their parents. */
function nodeAt(event: { clientX: number; clientY: number }): string | null {
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    const node = element.closest('.vue-flow__node')
    const id = node?.getAttribute('data-id')
    if (id) return id
  }
  return null
}

const placement = computed(() => {
  if (!sim.draggingType || !graph.value) return null
  return placeResource(graph.value, sim.draggingType, hovered.value)
})

function landingOf(): string | null {
  const place = placement.value
  if (!place || 'error' in place) return null
  if (place.subnetId) return place.subnetId
  if (place.vpcId && place.type !== 'vpc') return place.vpcId
  return graph.value?.nodes.find((node) => node.type === 'lane' && node.region === place.region)?.id ??
    graph.value?.nodes.find((node) => node.type === 'region' && node.region === place.region)?.id ??
    null
}

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes(SIM_DRAG_TYPE)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  const id = nodeAt(event)
  if (id === hovered.value) return
  hovered.value = id
  const landing = landingOf()
  if (landing !== dropTarget.value) {
    dropTarget.value = landing
    restyle()
  }
}

function clearDrop(): void {
  hovered.value = null
  if (dropTarget.value === null) return
  dropTarget.value = null
  restyle()
}

function onDragLeave(event: DragEvent): void {
  // Leaving for a child element is not leaving the canvas.
  const next = event.relatedTarget as Node | null
  if (!next || !(event.currentTarget as HTMLElement).contains(next)) clearDrop()
}

async function onDrop(event: DragEvent): Promise<void> {
  const type = event.dataTransfer?.getData(SIM_DRAG_TYPE) as SimResourceType | undefined
  // What the hint showed is what happens: the node last hovered, not a fresh
  // hit test, which can differ by a pixel at a container's edge.
  const target = hovered.value ?? nodeAt(event)
  clearDrop()
  sim.draggingType = null
  if (!type || !SIM_CATALOG.some((entry) => entry.type === type)) return
  event.preventDefault()
  await sim.quickAdd(type, target)
}

/** Exactly where the drop would land, shown while dragging. */
const dropHint = computed(() => {
  const place = placement.value
  if (!place) return null
  if ('error' in place) return { text: place.error, bad: true }
  const label = catalogEntry(place.type)?.label ?? place.type
  const nameOf = (id: string | null) => graph.value?.nodes.find((node) => node.id === id)
  const subnet = nameOf(place.subnetId)
  const vpc = nameOf(place.vpcId)
  const where = subnet
    ? `${subnet.name} (${subnet.isPublic ? 'public' : 'private'})`
    : vpc
      ? vpc.name
      : place.region
  return { text: `${label} → ${where}`, bad: false }
})

function onWindowDragEnd(): void {
  sim.draggingType = null
  clearDrop()
}
onMounted(() => window.addEventListener('dragend', onWindowDragEnd))
onBeforeUnmount(() => window.removeEventListener('dragend', onWindowDragEnd))

// ---------------------------------------------------------------------------
// Drag from one resource to another to connect them
// ---------------------------------------------------------------------------

const connectFrom = ref<string | null>(null)
const connectOver = ref<string | null>(null)

function onConnectStart(params: { event?: MouseEvent | TouchEvent } & OnConnectStartParams): void {
  connectFrom.value = params.nodeId ?? null
  restyle()
}

function onPointerMove(event: PointerEvent): void {
  if (!connectFrom.value) return
  const id = nodeAt(event)
  const over = id && id !== connectFrom.value && isResource(id) ? id : null
  if (over !== connectOver.value) {
    connectOver.value = over
    restyle()
  }
}

function isResource(id: string): boolean {
  const node = graph.value?.nodes.find((candidate) => candidate.id === id)
  return Boolean(node) && !['region', 'az', 'lane', 'internet', 'vpc', 'subnet'].includes(node!.type)
}

async function onConnectEnd(): Promise<void> {
  const source = connectFrom.value
  const target = connectOver.value
  connectFrom.value = null
  connectOver.value = null
  restyle()
  if (!source || !target) return
  const node = graph.value?.nodes.find((candidate) => candidate.id === target)
  await sim.connect(source, target, defaultPort(node, sim.current?.settings[target]))
  sim.focus(source)
}

// ---------------------------------------------------------------------------
// Clicks and keys
// ---------------------------------------------------------------------------

function onNodeClick(event: NodeMouseEvent): void {
  const node = graph.value?.nodes.find((candidate) => candidate.id === event.node.id)
  // VPCs and subnets are containers but also things to edit or remove here;
  // regions, zones and lanes are only structure.
  if (!node || ['region', 'az', 'lane', 'internet'].includes(node.type)) return
  sim.selectedId = node.id
}

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    void sim.undo()
  } else if (event.key === 'Escape') {
    sim.selectedId = null
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && sim.selectedId) {
    // Undo is one keystroke away, so no confirmation here.
    event.preventDefault()
    void sim.remove(sim.selectedId)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function toggle(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}
</script>

<template>
  <div
    class="ca-dotgrid ca-sim-canvas relative min-h-0 flex-1 overflow-hidden"
    :class="{ 'ca-sim-connecting': connectFrom }"
    @pointermove="onPointerMove"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <VueFlow
      :id="FLOW_ID"
      :nodes="nodes"
      :edges="edges"
      :min-zoom="0.15"
      :max-zoom="2.5"
      :nodes-draggable="false"
      :nodes-connectable="true"
      :connect-on-click="false"
      :edges-updatable="false"
      :zoom-on-double-click="false"
      class="h-full w-full"
      @node-click="onNodeClick"
      @connect-start="onConnectStart"
      @connect-end="onConnectEnd"
      @pane-click="sim.selectedId = null"
    >
      <template #node-resource="nodeProps">
        <ResourceNode :data="nodeProps.data" />
      </template>
      <template #node-container="nodeProps">
        <ContainerNode :data="nodeProps.data" @toggle="toggle($event)" />
      </template>
      <Panel position="bottom-left">
        <div class="flex overflow-hidden rounded-[8px] border border-border2 bg-panel">
          <button type="button" class="h-[30px] w-[30px] cursor-pointer border-r border-border text-muted hover:bg-raise hover:text-text" title="Zoom out" @click="zoomOut({ duration: 160 })">−</button>
          <button type="button" class="h-[30px] cursor-pointer border-r border-border px-[10px] text-[11.5px] text-muted hover:bg-raise hover:text-text" @click="fitView({ padding: 0.12, duration: 300 })">Fit</button>
          <button type="button" class="h-[30px] w-[30px] cursor-pointer text-muted hover:bg-raise hover:text-text" title="Zoom in" @click="zoomIn({ duration: 160 })">+</button>
        </div>
      </Panel>
      <Panel position="top-left">
        <div class="flex gap-[10px] rounded-[8px] border border-border bg-panel px-[10px] py-[5px] text-[10.5px] text-muted">
          <span><span class="font-bold text-ok">NEW</span> added</span>
          <span><span class="font-bold text-warn">EDITED</span> changed</span>
          <span>Drag from Add to place · drag a tile's edge dot to connect · ⌘Z undo · Del remove</span>
        </div>
      </Panel>
    </VueFlow>
    <Transition name="ca-fade">
      <div
        v-if="dropHint"
        class="pointer-events-none absolute left-1/2 top-[48px] -translate-x-1/2 rounded-[7px] border bg-panel px-[10px] py-[5px] text-[11.5px] font-medium shadow-lg"
        :class="dropHint.bad ? 'border-bad text-bad' : 'border-text text-text'"
      >
        {{ dropHint.text }}
      </div>
    </Transition>
    <Transition name="ca-fade">
      <div
        v-if="sim.saving"
        class="pointer-events-none absolute bottom-3 right-3 rounded-[7px] border border-border2 bg-panel px-[10px] py-[5px] text-[11px] text-muted"
      >
        Updating…
      </div>
    </Transition>
    <p v-if="error" class="absolute inset-x-0 top-12 text-center text-[12px] text-bad">{{ error }}</p>
  </div>
</template>
