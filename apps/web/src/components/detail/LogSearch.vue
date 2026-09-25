<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  LOG_TIME_RANGES,
  type LogEvent,
  type LogGroupRef,
  type LogQueryResponse,
} from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import CaEmptyState from '../ui/CaEmptyState.vue'

const props = defineProps<{ groups: LogGroupRef[]; region: string }>()

/** Only groups that exist can be searched; the rest are shown but not queried. */
const searchable = computed(() => props.groups.filter((group) => group.exists))

const selected = ref<Set<string>>(new Set())
const range = ref<(typeof LOG_TIME_RANGES)[number]>(LOG_TIME_RANGES[1])
const pattern = ref('')
const result = ref<LogQueryResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())

watch(
  searchable,
  (groups) => {
    selected.value = new Set(groups.map((group) => group.name))
    result.value = null
  },
  { immediate: true },
)

function toggle(name: string): void {
  const next = new Set(selected.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  selected.value = next
}

async function run(): Promise<void> {
  const logGroups = [...selected.value]
  if (logGroups.length === 0) return
  loading.value = true
  error.value = null
  const end = Date.now()
  try {
    result.value = await api.queryLogs({
      logGroups,
      region: props.region,
      start: end - range.value.ms,
      end,
      filterPattern: pattern.value,
      limit: 500,
    })
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

const SEVERITY_CLASS: Record<string, string> = {
  fatal: 'text-bad',
  error: 'text-bad',
  warn: 'text-warn',
  info: 'text-muted',
  debug: 'text-faint',
}

function severityClass(event: LogEvent): string {
  return event.severity ? (SEVERITY_CLASS[event.severity] ?? 'text-text') : 'text-text'
}

function time(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false })
}

/** Tallest bucket, so the histogram bars have something to scale against. */
const peak = computed(() =>
  Math.max(1, ...(result.value?.histogram ?? []).map((bucket) => bucket.count)),
)

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
</script>

<template>
  <div v-if="searchable.length > 0" class="mt-4">
    <div class="ca-eyebrow mb-[9px]">Search</div>

    <div class="flex flex-wrap items-center gap-[6px]">
      <button
        v-for="group in searchable"
        :key="group.name"
        type="button"
        class="max-w-[190px] truncate rounded-[6px] border px-[7px] py-[3px] font-mono text-[10.5px] transition-colors"
        :class="
          selected.has(group.name)
            ? 'border-border2 bg-raise text-text'
            : 'border-border bg-transparent text-faint hover:text-muted'
        "
        :title="group.name"
        @click="toggle(group.name)"
      >
        {{ group.name }}
      </button>
    </div>

    <div class="mt-[9px] flex items-center gap-[6px]">
      <input
        v-model="pattern"
        type="text"
        placeholder="Search text, or a { $.level = &quot;ERROR&quot; } pattern"
        class="h-[26px] min-w-0 flex-1 rounded-[6px] border border-border bg-panel px-[8px] text-[11.5px] text-text placeholder:text-faint focus:border-border2 focus:outline-none"
        @keydown.enter="run()"
      />
      <button
        v-for="option in LOG_TIME_RANGES"
        :key="option.id"
        type="button"
        class="h-[26px] shrink-0 cursor-pointer rounded-[6px] border px-[7px] text-[11px] transition-colors"
        :class="
          range.id === option.id
            ? 'border-border2 bg-raise text-text'
            : 'border-border bg-transparent text-muted hover:text-text'
        "
        @click="range = option"
      >
        {{ option.label }}
      </button>
      <button
        type="button"
        class="h-[26px] shrink-0 cursor-pointer rounded-[6px] border border-border2 bg-raise px-[10px] text-[11px] text-text disabled:opacity-50"
        :disabled="loading || selected.size === 0"
        @click="run()"
      >
        {{ loading ? '…' : 'Run' }}
      </button>
    </div>

    <CaEmptyState
      v-if="error"
      tone="error"
      class="mt-3"
      title="Log search failed"
      :description="error"
    />

    <div v-else-if="result" class="mt-3">
      <!-- Missing permissions are reported next to the results, not instead of
           them: a denial on one group must not hide what the others returned. -->
      <p
        v-if="result.missingPermissions.length > 0"
        class="mb-2 rounded-[6px] border border-warn/40 bg-warn/10 px-[9px] py-[6px] text-[11.5px] text-warn"
      >
        Some groups could not be read — missing {{ result.missingPermissions.join(', ') }}.
      </p>

      <div v-if="result.histogram.length > 0" class="mb-2 flex h-[34px] items-end gap-[1px]">
        <div
          v-for="bucket in result.histogram"
          :key="bucket.t"
          class="min-w-[2px] flex-1 rounded-t-[1px] bg-border2"
          :style="{ height: `${Math.max(6, (bucket.count / peak) * 100)}%` }"
          :title="`${bucket.count} at ${time(bucket.t)}`"
        />
      </div>

      <p v-if="result.truncated" class="mb-2 text-[11px] text-warn">
        Showing the most recent {{ result.events.length }} matches — there were more in this window.
      </p>

      <CaEmptyState
        v-if="result.events.length === 0"
        title="No matching events"
        :description="`Nothing in the last ${range.label} matched. The groups exist, so this is an empty result rather than a missing one.`"
      />

      <div v-else class="max-h-[420px] overflow-auto rounded-[8px] border border-border bg-panel2">
        <div
          v-for="event in result.events"
          :key="event.id"
          class="border-b border-border/60 px-[9px] py-[5px] last:border-b-0"
          :class="event.json ? 'cursor-pointer hover:bg-raise' : ''"
          @click="event.json ? toggleExpanded(event.id) : undefined"
        >
          <div class="flex gap-[8px] font-mono text-[10.5px] leading-[1.5]">
            <span class="shrink-0 text-faint">{{ time(event.timestamp) }}</span>
            <span class="min-w-0 flex-1 break-all" :class="severityClass(event)">{{
              event.message
            }}</span>
          </div>
          <pre
            v-if="event.json && expanded.has(event.id)"
            class="mt-[5px] overflow-auto rounded-[5px] bg-bg px-[8px] py-[6px] font-mono text-[10.5px] text-muted"
            >{{ JSON.stringify(event.json, null, 2) }}</pre
          >
        </div>
      </div>
    </div>
  </div>
</template>
