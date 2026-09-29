<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useComplianceStore } from '@/stores/compliance'
import { useGraphStore } from '@/stores/graph'
import { nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'

/**
 * Every resource in scope with its benchmark score, worst first.
 *
 * A resource's score is the share of the checks that ran on it which passed.
 * It is not weighted by severity on purpose — the failing checks are listed
 * beside it by name, so the reader weighs them rather than a formula.
 */

const emit = defineEmits<{ open: [nodeId: string] }>()
const compliance = useComplianceStore()
const graph = useGraphStore()

const typeFilter = ref<string | null>(null)
watch(
  () => compliance.scopeId,
  () => (typeFilter.value = null),
)

const types = computed(() => {
  const counts = new Map<string, { label: string; count: number }>()
  for (const row of compliance.resources) {
    const node = graph.nodeById.get(row.nodeId)
    if (!node) continue
    const entry = counts.get(node.type) ?? { label: node.typeLabel, count: 0 }
    entry.count += 1
    counts.set(node.type, entry)
  }
  return [...counts].map(([type, entry]) => ({ type, ...entry })).sort((a, b) => b.count - a.count)
})

const rows = computed(() =>
  compliance.resources
    .map((row) => ({ ...row, node: graph.nodeById.get(row.nodeId) }))
    .filter((row) => row.node && (!typeFilter.value || row.node.type === typeFilter.value)),
)

const withFailures = computed(() => rows.value.filter((row) => row.score.fail > 0).length)

function failingLabels(results: typeof compliance.resources[number]['results']) {
  return results
    .filter((result) => result.status !== 'pass')
    .map((result) => ({
      status: result.status,
      ref: compliance.benchmarkRef.get(result.checkId),
      title: compliance.checkById.get(result.checkId)?.title ?? result.checkId,
    }))
}
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-[6px]">
      <button
        type="button"
        class="cursor-pointer rounded-full border px-[9px] py-[2px] text-[11px] transition-colors"
        :class="typeFilter === null ? 'border-text bg-text text-bg' : 'border-border2 text-muted hover:text-text'"
        @click="typeFilter = null"
      >
        All · {{ compliance.resources.length }}
      </button>
      <button
        v-for="entry in types"
        :key="entry.type"
        type="button"
        class="cursor-pointer rounded-full border px-[9px] py-[2px] text-[11px] transition-colors"
        :class="typeFilter === entry.type ? 'border-text bg-text text-bg' : 'border-border2 text-muted hover:text-text'"
        @click="typeFilter = entry.type"
      >
        {{ entry.label }} · {{ entry.count }}
      </button>
      <span class="ml-auto text-[11.5px] text-muted">
        {{ withFailures }} of {{ rows.length }} with a failing check
      </span>
    </div>

    <div class="overflow-hidden rounded-[10px] border border-border bg-panel">
      <button
        v-for="row in rows"
        :key="row.nodeId"
        type="button"
        class="flex w-full cursor-pointer items-start gap-[11px] border-b border-border px-[12px] py-[9px] text-left last:border-b-0 hover:bg-raise/60"
        @click="emit('open', row.nodeId)"
      >
        <CaTile
          :abbr="row.node!.abbr"
          :color="nodeColor(row.node!)"
          :node-type="row.node!.type"
          :size="26"
          :radius="6"
        />
        <div class="w-[230px] shrink-0 min-w-0">
          <div class="truncate text-[12.5px] font-medium">{{ graph.displayName(row.node!) }}</div>
          <div class="truncate text-[11px] text-faint">{{ row.node!.typeLabel }} · {{ row.node!.az ?? row.node!.region }}</div>
        </div>

        <div class="w-[150px] shrink-0 pt-[3px]">
          <div class="flex items-baseline gap-2">
            <span
              class="font-mono text-[12.5px] font-semibold"
              :style="{ color: row.score.fail ? 'var(--ca-bad)' : row.score.unknown ? 'var(--ca-warn)' : 'var(--ca-ok)' }"
            >
              {{ row.score.percent === null ? '—' : `${row.score.percent}%` }}
            </span>
            <span class="text-[11px] text-faint">{{ row.score.pass }}/{{ row.score.total }} checks</span>
          </div>
          <div class="mt-[4px] flex h-[4px] overflow-hidden rounded-full bg-border">
            <span :style="{ flex: row.score.pass, background: 'var(--ca-ok)' }" />
            <span :style="{ flex: row.score.unknown, background: 'var(--ca-warn)' }" />
            <span :style="{ flex: row.score.fail, background: 'var(--ca-bad)' }" />
          </div>
        </div>

        <div class="flex min-w-0 flex-1 flex-wrap gap-[4px] pt-[1px]">
          <span
            v-for="label in failingLabels(row.results)"
            :key="label.title"
            class="rounded-[4px] border border-border px-[6px] py-[1px] text-[10.5px]"
            :style="{ color: label.status === 'fail' ? 'var(--ca-bad)' : 'var(--ca-warn)' }"
          >
            <span v-if="label.ref" class="mr-[5px] font-mono">{{ label.ref }}</span>{{ label.title }}
          </span>
          <span v-if="row.score.fail + row.score.unknown === 0" class="text-[11px] text-ok">
            ✓ Every check passes
          </span>
        </div>
      </button>
    </div>
  </div>
</template>
