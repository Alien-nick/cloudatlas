<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DatabaseLoad, GraphNode } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import CaEmptyState from '../ui/CaEmptyState.vue'

/**
 * Performance Insights for a database.
 *
 * The header states load against vCPUs because that comparison is the whole
 * reading: average active sessions above the vCPU count means sessions are
 * queuing, regardless of what CPU utilisation says. Showing the number without
 * the threshold leaves the user to know that rule, and most do not.
 */

const props = defineProps<{ node: GraphNode }>()

const RANGES = [
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
] as const

const range = ref<(typeof RANGES)[number]>(RANGES[0])
const load = ref<DatabaseLoad | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function fetchLoad(): Promise<void> {
  loading.value = true
  error.value = null
  const end = Date.now()
  try {
    load.value = await api.databaseLoad(props.node.id, end - range.value.ms, end)
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

watch(() => [props.node.id, range.value.id], () => void fetchLoad(), { immediate: true })

const saturated = computed(() => {
  const current = load.value
  if (!current || current.averageLoad === null || current.vcpus === null) return false
  return current.averageLoad > current.vcpus
})

const groups = computed(() => [
  { title: 'Top statements', rows: load.value?.topSql ?? [] },
  { title: 'Top wait events', rows: load.value?.topWaits ?? [] },
])
</script>

<template>
  <div>
    <div class="mb-3 flex items-center gap-2">
      <span class="text-[11.5px] text-muted">Performance Insights · average active sessions</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          v-for="option in RANGES"
          :key="option.id"
          type="button"
          class="h-[24px] cursor-pointer rounded-[6px] border px-[8px] text-[11px] transition-colors"
          :class="
            range.id === option.id
              ? 'border-border2 bg-raise text-text'
              : 'border-border bg-transparent text-muted hover:text-text'
          "
          @click="range = option"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="flex flex-col gap-2">
      <div v-for="n in 3" :key="n" class="h-[88px] animate-pulse rounded-[9px] bg-panel2" />
    </div>

    <CaEmptyState
      v-else-if="error"
      tone="error"
      title="Could not load Performance Insights"
      :description="error"
    />

    <CaEmptyState
      v-else-if="load?.unavailableReason"
      title="No Performance Insights data"
      :description="load.unavailableReason"
    />

    <div v-else-if="load" class="flex flex-col gap-3">
      <div
        class="rounded-[9px] border px-[11px] py-[9px]"
        :class="saturated ? 'border-bad/50 bg-bad/10' : 'border-border bg-panel2'"
      >
        <div class="flex items-baseline gap-2">
          <span class="font-mono text-[17px] font-medium" :class="saturated ? 'text-bad' : 'text-text'">
            {{ load.averageLoad ?? '—' }}
          </span>
          <span class="text-[11.5px] text-muted">average active sessions</span>
          <span v-if="load.vcpus !== null" class="ml-auto font-mono text-[11px] text-faint">
            {{ load.vcpus }} vCPU
          </span>
        </div>
        <p class="mt-[5px] text-[11.5px] leading-[1.5]" :class="saturated ? 'text-bad' : 'text-muted'">
          {{
            load.vcpus === null
              ? 'vCPU count unknown, so there is no line to read this against.'
              : saturated
                ? `Load is above ${load.vcpus} vCPUs — sessions are queuing rather than running.`
                : `Load is within ${load.vcpus} vCPUs, so sessions are not queuing on CPU.`
          }}
        </p>
      </div>

      <div
        v-for="group in groups"
        :key="group.title"
        class="rounded-[9px] border border-border bg-panel2 px-[11px] py-[9px]"
      >
        <div class="ca-eyebrow mb-[7px]">{{ group.title }}</div>
        <p v-if="group.rows.length === 0" class="text-[11.5px] text-faint">Nothing to show.</p>
        <div v-for="row in group.rows" :key="row.label" class="mb-[7px] last:mb-0">
          <div class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 break-all font-mono text-[10.5px] leading-[1.5]">{{
              row.label
            }}</span>
            <span class="shrink-0 font-mono text-[10.5px] text-muted">{{ row.load }}</span>
          </div>
          <div class="mt-[3px] h-[3px] w-full rounded-full bg-border">
            <div
              class="h-full rounded-full"
              :class="saturated ? 'bg-bad' : 'bg-border2'"
              :style="{ width: `${Math.round(row.share * 100)}%` }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
