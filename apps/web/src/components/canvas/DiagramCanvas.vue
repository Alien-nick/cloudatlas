<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Panel, VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { diagramBounds, exportFilename, exportPng, exportSvg } from '@/lib/export'
import { cssVar } from '@/lib/chart'
import { MiniMap } from '@vue-flow/minimap'
import { isContainerType } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import { categoryColor } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import ContainerNode from './ContainerNode.vue'
import ResourceNode from './ResourceNode.vue'
import { computeLayout, decorate, type DiagramLayout, type FlowEdge, type FlowNode } from './useDiagram'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const FLOW_ID = 'cloudatlas'
const { fitView, zoomIn, zoomOut, viewport, getNodes, onPaneClick, onNodesInitialized } =
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
  const viewportEl = document.querySelector<HTMLElement>('.vue-flow__viewport')
  const bounds = diagramBounds(getNodes.value)
  if (!viewportEl || !bounds) {
    exportError.value = 'Nothing to export yet — wait for the layout to finish.'
    return
  }

  exporting.value = true
  exportError.value = null
  try {
    const options = {
      viewport: viewportEl,
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
        <ContainerNode :data="nodeProps.data" @toggle="graph.toggleCollapsed($event)" />
      </template>

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
