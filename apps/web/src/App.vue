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
import LogsView from '@/components/views/LogsView.vue'
import ResourceDetailView from '@/components/views/ResourceDetailView.vue'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const showFirstRun = ref(false)
let healthTimer: number | null = null

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

onBeforeUnmount(() => {
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
        <ResourceDetailView v-else-if="app.view === 'resource'" />
      </main>

      <DetailPanel
        v-if="!showFirstRun && graph.graph && app.panelOpen && app.view !== 'resource'"
      />
      <AgentPanel v-if="!showFirstRun && graph.graph" />
    </div>

    <CommandPalette v-if="graph.graph" />
  </div>
</template>
