<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GraphNode, WafSampledResponse } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import CaEmptyState from '../ui/CaEmptyState.vue'

/**
 * Sampled requests for a web ACL.
 *
 * WAF keeps a three-hour sample, not a full log, and each sample carries a
 * weight saying how many real requests it stands for. The counts below are
 * summed weights, so they are estimates of real traffic rather than row counts
 * — the header says so, because a number presented without that caveat would
 * be read as exact.
 */

const props = defineProps<{ node: GraphNode }>()

const RANGES = [
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '3h', label: '3h', ms: 3 * 60 * 60_000 },
] as const

const range = ref<(typeof RANGES)[number]>(RANGES[1])
const result = ref<WafSampledResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  const end = Date.now()
  try {
    result.value = await api.wafSampled({
      webAclNodeId: props.node.id,
      start: end - range.value.ms,
      end,
    })
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

watch(() => [props.node.id, range.value.id], () => void load(), { immediate: true })

const blocked = computed(() =>
  (result.value?.requests ?? [])
    .filter((request) => request.action === 'BLOCK')
    .reduce((total, request) => total + request.weight, 0),
)

const groups = computed(() => [
  { title: 'By rule', rows: result.value?.byRule ?? [] },
  { title: 'By client IP', rows: result.value?.byClientIp ?? [] },
  { title: 'By country', rows: result.value?.byCountry ?? [] },
  { title: 'By URI', rows: result.value?.byUri ?? [] },
])

const peak = (rows: Array<{ count: number }>): number =>
  Math.max(1, ...rows.map((row) => row.count))
</script>

<template>
  <div>
    <div class="mb-3 flex items-center gap-2">
      <span class="text-[11.5px] text-muted">Sampled requests · last three hours retained</span>
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
      <div v-for="n in 4" :key="n" class="h-[92px] animate-pulse rounded-[9px] bg-panel2" />
    </div>

    <CaEmptyState
      v-else-if="error"
      tone="error"
      title="Could not load sampled requests"
      :description="error"
    />

    <CaEmptyState
      v-else-if="result && result.requests.length === 0"
      title="No sampled requests"
      description="WAF returned no samples for this window. It keeps a three-hour sample rather than a full log, so an idle ACL and a window outside retention both look like this."
    />

    <div v-else-if="result" class="flex flex-col gap-3">
      <p class="text-[11.5px] leading-[1.5] text-muted">
        <span class="font-mono text-text">{{ blocked.toLocaleString() }}</span> blocked requests
        estimated from {{ result.requests.length }} samples. Counts are summed sample weights, not
        exact totals.
      </p>

      <div
        v-for="group in groups"
        :key="group.title"
        class="rounded-[9px] border border-border bg-panel2 px-[11px] py-[9px]"
      >
        <div class="ca-eyebrow mb-[7px]">{{ group.title }}</div>
        <p v-if="group.rows.length === 0" class="text-[11.5px] text-faint">Nothing to show.</p>
        <div v-for="row in group.rows.slice(0, 8)" :key="row.key" class="mb-[5px] last:mb-0">
          <div class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-[10.5px]" :title="row.key">{{
              row.key
            }}</span>
            <span class="shrink-0 font-mono text-[10.5px] text-muted">{{
              row.count.toLocaleString()
            }}</span>
          </div>
          <div class="mt-[2px] h-[3px] w-full rounded-full bg-border">
            <div
              class="h-full rounded-full bg-bad"
              :style="{ width: `${(row.count / peak(group.rows)) * 100}%` }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
