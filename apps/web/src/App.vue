<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import CaEmptyState from '@/components/ui/CaEmptyState.vue'
import AgentPanel from '@/components/AgentPanel.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import DetailPanel from '@/components/detail/DetailPanel.vue'
import SideBar from '@/components/SideBar.vue'
import TopBar from '@/components/TopBar.vue'
import CanvasView from '@/components/views/CanvasView.vue'
import FirstRun from '@/components/views/FirstRun.vue'
import HealthView from '@/components/views/HealthView.vue'
import InventoryView from '@/components/views/InventoryView.vue'
import AnalyticsView from '@/components/views/AnalyticsView.vue'
import ComplianceView from '@/components/views/ComplianceView.vue'
import CostView from '@/components/views/CostView.vue'
import SimulateView from '@/components/views/SimulateView.vue'
import LogsView from '@/components/views/LogsView.vue'
import ResourceDetailView from '@/components/views/ResourceDetailView.vue'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const showFirstRun = ref(false)
let healthTimer: number | null = null
let scanTimer: number | null = null

const isCanvasView = computed(
  () => app.view === 'topology' || app.view === 'network' || app.view === 'security',
)

onMounted(async () => {
  await app.bootstrap()
  const hasGraph = await graph.loadCachedGraph()
  if (hasGraph) {
    await Promise.all([app.loadIdentity(), health.load()])
  } else {
    showFirstRun.value = true
  }
})

// Once a scan lands, leave the first-run screen and pull health in.
watch(
  () => graph.graph,
  (value) => {
    if (!value) return
    showFirstRun.value = false
    void health.load()
  },
)

// Poll health on the configured interval; findings drive badges everywhere.
watch(
  () => app.info?.healthPollSeconds ?? 60,
  (seconds) => {
    if (healthTimer !== null) window.clearInterval(healthTimer)
    healthTimer = window.setInterval(() => {
      if (graph.graph) void health.load()
    }, Math.max(15, seconds) * 1000)
  },
  { immediate: true },
)

/**
 * Re-scan on the configured interval.
 *
 * Separate from the health poll, and much slower, because the two answer
 * different questions. Health re-reads metrics and findings for resources that
 * already exist; a scan re-reads the estate itself and is the only thing that
 * notices an instance appearing or a security group changing.
 *
 * Skipped while a scan is already running and while the user is reading a
 * resource page, because re-laying out the diagram underneath someone is worse
 * than a slightly stale one.
 */
watch(
  () => app.info?.autoRefreshSeconds ?? 600,
  (seconds) => {
    if (scanTimer !== null) window.clearInterval(scanTimer)
    scanTimer = null
    if (seconds <= 0) return
    scanTimer = window.setInterval(
      () => {
        if (!app.profile || graph.scanning || app.view === 'resource') return
        graph.startScan(app.profile, graph.selectedRegions)
      },
      Math.max(60, seconds) * 1000,
    )
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (scanTimer !== null) window.clearInterval(scanTimer)
  if (healthTimer !== null) window.clearInterval(healthTimer)
  graph.cancelScan()
})

function reconnect(): void {
  graph.cancelScan()
  showFirstRun.value = true
}

function onSearch(): void {
  app.paletteOpen = true
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    // Toggle, so the same chord that opens it also dismisses it.
    app.paletteOpen = !app.paletteOpen
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="flex h-full min-w-[1280px] flex-col bg-bg text-text">
    <TopBar @reconnect="reconnect" @search="onSearch" />

    <div class="flex min-h-0 flex-1">
      <SideBar />

      <main class="flex min-w-0 flex-1 flex-col bg-canvas">
        <CaEmptyState
          v-if="app.error"
          tone="error"
          class="flex-1"
          title="Cannot reach the CloudAtlas API"
          :description="app.error"
        />

        <FirstRun v-else-if="showFirstRun || !graph.graph" />

        <CanvasView v-else-if="isCanvasView" />
        <HealthView v-else-if="app.view === 'health'" />
        <InventoryView v-else-if="app.view === 'inventory'" />
        <LogsView v-else-if="app.view === 'logs'" />
        <AnalyticsView v-else-if="app.view === 'analytics'" />
        <ComplianceView v-else-if="app.view === 'compliance'" />
        <CostView v-else-if="app.view === 'cost'" />
        <SimulateView v-else-if="app.view === 'simulate'" />
        <ResourceDetailView v-else-if="app.view === 'resource'" />
      </main>

      <DetailPanel
        v-if="!showFirstRun && graph.graph && app.panelOpen && app.view !== 'resource' && app.view !== 'simulate'"
      />
      <AgentPanel v-if="!showFirstRun && graph.graph" />
    </div>

    <CommandPalette v-if="graph.graph" />
  </div>
</template>
