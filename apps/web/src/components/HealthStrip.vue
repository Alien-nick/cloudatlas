<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const chips = computed(() => {
  const out: Array<{ id: 'critical' | 'warning'; label: string; color: string }> = []
  if (health.criticalCount > 0) {
    out.push({
      id: 'critical',
      label: `${health.criticalCount} critical`,
      color: 'var(--ca-bad)',
    })
  }
  if (health.warningCount > 0) {
    out.push({
      id: 'warning',
      label: `${health.warningCount} warning${health.warningCount === 1 ? '' : 's'}`,
      color: 'var(--ca-warn)',
    })
  }
  return out
})

/** Jump to the first affected resource and open its Metrics tab. */
function focus(severity: 'critical' | 'warning'): void {
  const finding =
    severity === 'critical'
      ? health.incidents.find((f) => f.severity === 'critical')
      : (health.incidents.find((f) => f.severity === 'warning') ?? health.posture[0])
  if (!finding) return
  graph.select(finding.nodeId)
  app.detailTab = finding.metric ? 'metrics' : 'security'
  if (app.view === 'inventory' || app.view === 'logs') app.setView('topology')
}
</script>

<template>
  <div v-if="chips.length > 0" class="flex items-center gap-[6px]">
    <button
      v-for="chip in chips"
      :key="chip.id"
      type="button"
      class="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-[7px] border bg-panel2 px-[9px] text-[12px] transition-colors hover:bg-raise"
      :style="{ borderColor: chip.color, color: chip.color }"
      :title="`Show the first ${chip.id} finding`"
      @click="focus(chip.id)"
    >
      <span
        class="h-[6px] w-[6px] rounded-full"
        :style="{
          background: chip.color,
          animation: chip.id === 'critical' ? 'ca-pulse 2s ease-out infinite' : undefined,
        }"
      />
      {{ chip.label }}
    </button>
  </div>
  <div
    v-else-if="health.findings.length === 0 && !health.loading && graph.graph"
    class="flex h-[30px] items-center gap-[6px] rounded-[7px] border border-border bg-panel2 px-[9px] text-[12px] text-muted"
  >
    <span class="h-[6px] w-[6px] rounded-full bg-ok" />
    All clear
  </div>
</template>
