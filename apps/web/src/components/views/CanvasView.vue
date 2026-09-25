<script setup lang="ts">
import { computed } from 'vue'
import {
  EDGE_STYLES,
  SECTION_LABELS,
  type CollectorSection,
  type EdgeKind,
} from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaScanNotice from '../ui/CaScanNotice.vue'
import DiagramCanvas from '../canvas/DiagramCanvas.vue'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const LEGEND_COLORS: Record<EdgeKind, string> = {
  traffic: 'var(--ca-edge)',
  sg: '#8C4FFF',
  event: '#E7157B',
  risk: '#f2555a',
}

const legend = computed<EdgeKind[]>(() =>
  app.view === 'security' ? ['traffic', 'sg', 'event', 'risk'] : ['traffic', 'sg', 'event'],
)

/** Account › region › VPC, derived from whatever is currently selected. */
const breadcrumb = computed(() => {
  const parts: Array<{ text: string; mono?: boolean; strong?: boolean }> = [
    { text: app.accountLabel },
  ]
  const node = graph.selectedNode
  if (node) {
    if (node.region && node.region !== 'global') parts.push({ text: node.region, mono: true })
    else parts.push({ text: 'global', mono: true })
    const vpc = node.vpcId ? graph.nodeById.get(node.vpcId) : null
    if (vpc) parts.push({ text: vpc.name, strong: true })
  } else {
    const regions = graph.selectedRegions
    parts.push({ text: regions[0] ?? '—', mono: true })
  }
  return parts
})

/** Sections whose data is missing, so the diagram is knowingly incomplete. */
const affectedLabels = computed(() =>
  graph.affectedSections
    .map((section) => SECTION_LABELS[section as CollectorSection] ?? section)
    .join(', '),
)

/** Risky rules are summarised as a banner over the canvas in Security view. */
const riskFindings = computed(() =>
  health.posture.filter((f) => f.kind === 'risky-sg-rule'),
)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex h-[38px] shrink-0 items-center gap-2 border-b border-border bg-panel px-[14px]"
    >
      <template v-for="(part, index) in breadcrumb" :key="index">
        <span v-if="index > 0" class="text-[11px] text-faint">›</span>
        <span
          :class="[
            part.mono ? 'font-mono text-[11.5px]' : 'text-[12.5px]',
            part.strong ? 'font-semibold text-text' : 'text-muted',
          ]"
          >{{ part.text }}</span
        >
      </template>
      <span class="ml-[14px] text-[11.5px] text-faint">{{ graph.focusCount }}</span>

      <div class="ml-auto flex items-center gap-[6px]">
        <div
          v-for="kind in legend"
          :key="kind"
          class="flex items-center gap-[6px] rounded-[6px] border border-border bg-panel2 px-2 py-[3px]"
        >
          <svg width="20" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="20"
              y2="3"
              :stroke="LEGEND_COLORS[kind]"
              stroke-width="1.6"
              :stroke-dasharray="EDGE_STYLES[kind].dash"
            />
          </svg>
          <span class="text-[11px] whitespace-nowrap text-muted">{{ EDGE_STYLES[kind].label }}</span>
        </div>
      </div>
    </div>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <DiagramCanvas v-if="graph.visibleNodes.length > 0" />
      <div v-else class="ca-dotgrid flex flex-1 items-center justify-center">
        <CaEmptyState
          title="Nothing matches the current filters"
          description="Every resource was filtered out. Re-enable a service type, clear the tag filter, or select another region."
        />
      </div>

      <!-- The diagram is incomplete and says so, rather than looking healthy. -->
      <!-- The wrapper is a positioning box, not a surface. Without
           pointer-events-none its full width swallows clicks on resources that
           merely sit near the notice rather than under it. -->
      <div
        v-if="graph.hasScanIssues"
        class="pointer-events-none absolute right-[14px] top-[14px] z-10 w-[380px] max-w-[calc(100%-28px)]"
      >
        <div class="pointer-events-auto">
        <CaScanNotice
          variant="banner"
          collapsible
          :permissions="graph.missingPermissions"
          :failures="graph.collectorFailures"
          :affects="affectedLabels"
        />
        </div>
      </div>

      <div
        v-if="app.view === 'security' && riskFindings.length > 0"
        class="ca-panel-shadow absolute left-[14px] top-[14px] flex items-center gap-[10px] rounded-[9px] border bg-panel px-3 py-[9px]"
        style="border-color: rgba(242, 85, 90, 0.45)"
      >
        <span
          class="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-bad text-[11px] font-bold text-white"
          >!</span
        >
        <div>
          <div class="text-[12.5px] font-semibold">
            {{ riskFindings.length }} risky rule{{ riskFindings.length === 1 ? '' : 's' }}
          </div>
          <button
            type="button"
            class="cursor-pointer text-left font-mono text-[11.5px] text-muted hover:text-text"
            @click="graph.select(riskFindings[0]!.nodeId)"
          >
            {{ riskFindings[0]!.title }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
