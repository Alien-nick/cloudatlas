<script setup lang="ts">
import { computed } from 'vue'
import type { GraphNode } from '@cloudatlas/shared'
import { useHealthStore } from '@/stores/health'
import { formatCurrency, relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'

const props = withDefaults(
  defineProps<{
    node: GraphNode
    /**
     * The full-page view leads with a richer version of the same findings, so
     * it suppresses these rather than showing each one twice.
     */
    hideFindings?: boolean
  }>(),
  { hideFindings: false },
)
const health = useHealthStore()

const findings = computed(() => health.findingsByNode.get(props.node.id) ?? [])
const alarms = computed(() => health.alarmsForNode(props.node.id).filter((a) => a.state === 'ALARM'))
</script>

<template>
  <div>
    <!-- Open findings lead, because that is why you opened the panel. -->
    <div v-if="!hideFindings && findings.length > 0" class="mb-4 flex flex-col gap-2">
      <div
        v-for="finding in findings"
        :key="finding.id"
        class="rounded-[9px] border px-[11px] py-[10px]"
        :style="{
          borderColor:
            finding.severity === 'critical' ? 'rgba(242,85,90,.45)' : 'rgba(210,153,34,.45)',
          background:
            finding.severity === 'critical' ? 'rgba(242,85,90,.07)' : 'rgba(210,153,34,.07)',
        }"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold text-white"
            :style="{
              background: finding.severity === 'critical' ? 'var(--ca-bad)' : 'var(--ca-warn)',
            }"
            >!</span
          >
          <div class="min-w-0">
            <div class="text-[12.5px] font-semibold">{{ finding.title }}</div>
            <div class="mt-[2px] text-[11.5px] leading-[1.5] text-muted">
              Started {{ relativeTime(finding.startedAt) }}
            </div>
          </div>
        </div>
      </div>
      <div
        v-for="alarm in alarms"
        :key="alarm.name"
        class="flex items-center gap-2 rounded-[8px] border border-border bg-panel2 px-[11px] py-[8px]"
      >
        <span class="h-[6px] w-[6px] shrink-0 rounded-full bg-bad" />
        <span class="font-mono text-[11px] text-muted">{{ alarm.name }}</span>
        <span class="ml-auto text-[10.5px] text-bad">ALARM</span>
      </div>
    </div>

    <div v-if="node.props.length > 0" class="flex flex-col">
      <div
        v-for="prop in node.props"
        :key="prop.k"
        class="flex gap-3 border-b border-border py-2 last:border-b-0"
      >
        <div class="w-[112px] shrink-0 text-[12px] text-muted">{{ prop.k }}</div>
        <div
          class="min-w-0 flex-1 break-all text-[11.5px]"
          :class="prop.mono ? 'font-mono' : ''"
        >
          {{ prop.v }}
        </div>
      </div>
      <div
        v-if="node.monthlyCostUsd !== null"
        class="flex gap-3 border-t border-border py-2"
      >
        <div class="w-[112px] shrink-0 text-[12px] text-muted">Monthly est.</div>
        <div class="flex-1 font-mono text-[11.5px]">{{ formatCurrency(node.monthlyCostUsd) }}</div>
      </div>
    </div>

    <CaEmptyState
      v-else
      title="No properties collected"
      description="This resource type has no describe output mapped yet."
    />

    <a
      v-if="node.consoleUrl"
      :href="node.consoleUrl"
      target="_blank"
      rel="noreferrer noopener"
      class="mt-[14px] inline-flex items-center gap-[6px] text-[12.5px]"
    >
      Open in AWS Console <span class="text-[10px]">↗</span>
    </a>
  </div>
</template>
