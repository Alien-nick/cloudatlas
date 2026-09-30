<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Panel, VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { exportFilename, exportPng, exportSvg, renderedBounds } from '@/lib/export'
import { cssVar } from '@/lib/chart'
import { MiniMap } from '@vue-flow/minimap'
import { isContainerType } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import { useSimulationStore } from '@/stores/simulation'
import { categoryColor } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import ContainerNode from './ContainerNode.vue'
import ResourceNode from './ResourceNode.vue'
import { computeLayout, decorate, type DiagramLayout, type FlowEdge, type FlowNode } from './useDiagram'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()
const sim = useSimulationStore()

/**
 * VPCs picked for a simulation, straight from the diagram. Pick one or
 * several with their Simulate chips; the bar at the bottom clones them.
 */
const picks = ref(new Set<string>())
const includeOutside = ref(false)
const cloning = ref(false)

function togglePick(id: string): void {
  const next = new Set(picks.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picks.value = next
}

const pickedVpcs = computed(() =>
  [...picks.value]
    .map((id) => graph.graph?.nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node)),
)
// A rescan can drop a VPC; a pick of something gone is dropped with it.
watch(
  () => graph.graph,
  (next) => {
    const ids = new Set(next?.nodes.filter((node) => node.type === 'vpc').map((node) => node.id) ?? [])
    if ([...picks.value].some((id) => !ids.has(id))) picks.value = new Set([...picks.value].filter((id) => ids.has(id)))
  },
)

async function clonePicked(): Promise<void> {
  const vpcs = pickedVpcs.value
  if (vpcs.length === 0 || cloning.value) return
  cloning.value = true
  const name =
    vpcs.length === 1 ? `${graph.displayName(vpcs[0]!)} · simulation` : `${vpcs.map((vpc) => graph.displayName(vpc)).join(' + ')} · simulation`
  await sim.create(name.length > 80 ? `${vpcs.length} VPCs · simulation` : name, {
    vpcIds: vpcs.map((vpc) => vpc.id),
    includeOutside: includeOutside.value,
  })
  cloning.value = false
  if (sim.current) {
    picks.value = new Set()
    app.setView('simulate')
  }
}

const FLOW_ID = 'cloudatlas'
const { fitView, zoomIn, zoomOut, viewport, onPaneClick, onNodesInitialized } =
  useVueFlow(FLOW_ID)

const layout = shallowRef<DiagramLayout | null>(null)
const nodes = shallowRef<FlowNode[]>([])
const edges = shallowRef<FlowEdge[]>([])
const layingOut = ref(false)
const layoutError = ref<string | null>(null)

/** Bumped per request so a slow layout can never overwrite a newer one. */
let generation = 0
/** Set while a fresh layout is waiting for Vue Flow to measure its nodes. */
let fitPending = false

function applyFit(): void {
  fitPending = false
  void fitView({ padding: 0.12, duration: 300 })
}

function scheduleFit(): void {
  fitPending = true
  // Fall back in case the node set is unchanged and the hook never re-fires.
  // Deliberately long enough that Vue Flow has finished measuring.
  window.setTimeout(() => {
    if (fitPending) applyFit()
  }, 500)
}

// Node dimensions are only known once Vue Flow mounts them, so framing the
// diagram waits for this hook rather than a guessed frame count.
onNodesInitialized(() => {
  if (fitPending) applyFit()
})

/** Only these inputs change the geometry; everything else just restyles. */
const structureKey = computed(
  () =>
    `${graph.visibleNodes.map((n) => n.id).join('|')}##${graph.visibleEdges
      .map((e) => e.id)
      .join('|')}##${[...graph.collapsedContainers].sort().join('|')}`,
)

async function relayout(fit = true): Promise<void> {
  const token = ++generation
  if (graph.visibleNodes.length === 0) {
    layout.value = null
    nodes.value = []
    edges.value = []
    return
  }

  layingOut.value = true
  layoutError.value = null
  try {
    const next = await computeLayout(
      graph.visibleNodes,
      graph.visibleEdges,
      graph.collapsedContainers,
    )
    if (token !== generation) return
    layout.value = next
    restyle()
    if (fit) scheduleFit()
  } catch (error) {
    if (token !== generation) return
    layoutError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (token === generation) layingOut.value = false
  }
}

/** Cheap pass: re-derives styling from the existing geometry. */
function restyle(): void {
  const current = layout.value
  if (!current) return
  const result = decorate(current, {
    findingsByNode: health.findingsByNode,
    selectedId: graph.selectedId,
    highlightedIds: graph.highlightedIds,
    showEdgeLabels: app.view === 'security',
    securityView: app.view === 'security',
  })
  nodes.value = result.nodes
  edges.value = result.edges
}

watch(structureKey, () => void relayout(), { immediate: true })
watch(
  () => [graph.selectedId, graph.hoveredId, app.view, health.findings] as const,
  () => restyle(),
  { deep: false },
)

onPaneClick(() => {
  graph.hoveredId = null
})

function onNodeClick(event: NodeMouseEvent): void {
  const node = graph.nodeById.get(event.node.id)
  if (!node || isContainerType(node.type)) return
  graph.select(node.id)
  app.detailTab = 'overview'
}

function onNodeEnter(event: NodeMouseEvent): void {
  const node = graph.nodeById.get(event.node.id)
  if (!node || isContainerType(node.type)) return
  graph.hoveredId = node.id
}

const zoomLabel = computed(() => `${Math.round((viewport.value?.zoom ?? 1) * 100)}%`)

function minimapColor(node: { id: string }): string {
  const graphNode = graph.nodeById.get(node.id)
  if (!graphNode || isContainerType(graphNode.type)) return 'transparent'
  return categoryColor(graphNode.category)
}

onBeforeUnmount(() => {
  generation++
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exporting = ref(false)
const exportError = ref<string | null>(null)

async function runExport(format: 'PNG' | 'SVG'): Promise<void> {
  if (exporting.value) return
  const pane = document.querySelector<HTMLElement>('.vue-flow__transformationpane')
  const bounds = pane ? renderedBounds(pane) : null
  if (!pane || !bounds) {
    exportError.value = 'Nothing to export yet — wait for the layout to finish.'
    return
  }

  exporting.value = true
  exportError.value = null
  try {
    const options = {
      pane,
      bounds,
      background: cssVar('--ca-canvas', '#0d1013'),
      filename: exportFilename(
        graph.graph?.accountAlias ?? graph.graph?.accountId ?? 'cloudatlas',
        (graph.graph?.regions ?? []).map((region) => region.id),
        format === 'PNG' ? 'png' : 'svg',
      ),
    }
    if (format === 'PNG') await exportPng(options)
    else await exportSvg(options)
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : String(error)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="ca-dotgrid relative min-h-0 flex-1 overflow-hidden">
    <VueFlow
      :id="FLOW_ID"
      :nodes="nodes"
      :edges="edges"
      :min-zoom="0.15"
      :max-zoom="2.5"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :edges-updatable="false"
      :elevate-edges-on-select="false"
      :zoom-on-double-click="false"
      class="h-full w-full"
      @node-click="onNodeClick"
      @node-mouse-enter="onNodeEnter"
      @node-mouse-leave="graph.hoveredId = null"
    >
      <template #node-resource="nodeProps">
        <ResourceNode :data="nodeProps.data" />
      </template>
      <template #node-container="nodeProps">
        <ContainerNode
          :data="nodeProps.data"
          simulatable
          :picked="picks.has(nodeProps.id)"
          @toggle="graph.toggleCollapsed($event)"
          @simulate="togglePick($event)"
        />
      </template>

      <Panel v-if="pickedVpcs.length" position="top-center" class="!mt-[46px]">
        <div class="flex items-center gap-[12px] whitespace-nowrap rounded-[10px] border border-[#8C4FFF]/70 bg-panel px-[12px] py-[8px] shadow-xl">
          <span class="text-[12px] font-semibold">
            {{ pickedVpcs.length }} VPC{{ pickedVpcs.length === 1 ? '' : 's' }} picked
          </span>
          <span class="max-w-[260px] truncate text-[11px] text-muted" :title="pickedVpcs.map((vpc) => graph.displayName(vpc)).join(', ')">
            {{ pickedVpcs.map((vpc) => graph.displayName(vpc)).join(', ') }}
          </span>
          <label class="flex cursor-pointer items-center gap-[5px] text-[11px] text-muted">
            <input v-model="includeOutside" type="checkbox" class="cursor-pointer" />
            + services outside VPCs
          </label>
          <button
            type="button"
            class="h-[28px] cursor-pointer rounded-[7px] bg-[#8C4FFF] px-[12px] text-[11.5px] font-semibold text-white hover:bg-[#7a3ff0] disabled:opacity-60"
            :disabled="cloning"
            @click="clonePicked"
          >
            {{ cloning ? 'Cloning…' : 'Clone into simulation' }}
          </button>
          <button type="button" class="cursor-pointer text-[11px] text-muted hover:text-text" @click="picks = new Set()">
            Clear
          </button>
        </div>
      </Panel>
      <Panel position="bottom-left">
        <div class="flex flex-wrap gap-[6px]">
          <div class="flex overflow-hidden rounded-[8px] border border-border2 bg-panel">
            <button
              type="button"
              class="h-[30px] w-[30px] cursor-pointer border-r border-border bg-transparent text-[14px] text-muted hover:bg-raise hover:text-text"
              title="Zoom out"
              @click="zoomOut({ duration: 160 })"
            >
              −
            </button>
            <div
              class="flex h-[30px] w-[52px] items-center justify-center border-r border-border font-mono text-[11px] text-muted"
            >
              {{ zoomLabel }}
            </div>
            <button
              type="button"
              class="h-[30px] w-[30px] cursor-pointer bg-transparent text-[14px] text-muted hover:bg-raise hover:text-text"
              title="Zoom in"
              @click="zoomIn({ duration: 160 })"
            >
              +
            </button>
          </div>
          <button
            type="button"
            class="h-[30px] cursor-pointer rounded-[8px] border border-border2 bg-panel px-[11px] text-[12px] text-muted hover:text-text"
            @click="fitView({ padding: 0.14, duration: 260 })"
          >
            Fit
          </button>
          <button
            type="button"
            class="h-[30px] cursor-pointer rounded-[8px] border border-border2 bg-panel px-[11px] text-[12px] text-muted hover:text-text disabled:cursor-wait disabled:opacity-50"
            :disabled="layingOut"
            title="Re-run the ELK layout"
            @click="relayout()"
          >
            {{ layingOut ? 'Laying out…' : 'Auto-layout' }}
          </button>
          <div class="flex overflow-hidden rounded-[8px] border border-border2 bg-panel">
            <div
              class="flex h-[30px] items-center border-r border-border px-[10px] text-[12px] text-muted"
            >
              {{ exporting ? 'Exporting…' : 'Export' }}
            </div>
            <button
              v-for="format in (['PNG', 'SVG'] as const)"
              :key="format"
              type="button"
              :disabled="exporting"
              class="h-[30px] cursor-pointer border-r border-border bg-transparent px-[9px] font-mono text-[11px] text-muted transition-colors last:border-r-0 hover:text-text disabled:cursor-wait"
              :title="`Export the whole diagram as ${format}`"
              @click="runExport(format)"
            >
              {{ format }}
            </button>
          </div>
        </div>
      </Panel>

      <MiniMap
        pannable
        zoomable
        :width="190"
        :height="126"
        :node-color="minimapColor"
        :node-stroke-width="0"
        :node-border-radius="2"
        mask-color="rgba(127,140,155,.20)"
        class="!rounded-[8px] !border !border-border2 !bg-panel"
      />
    </VueFlow>

    <div v-if="layoutError" class="absolute inset-0 flex items-center justify-center bg-canvas/85">
      <CaEmptyState tone="error" title="Layout failed" :description="layoutError" />
    </div>
  </div>
</template>
