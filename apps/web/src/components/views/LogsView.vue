<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  INSIGHTS_TEMPLATES,
  LOG_TIME_RANGES,
  templatesForKinds,
  type InsightsResponse,
  type LogEvent,
  type LogGroupRef,
  type LogQueryResponse,
} from '@cloudatlas/shared'
import { api, ApiError, streamTail } from '@/lib/api'
import { useGraphStore } from '@/stores/graph'
import CaEmptyState from '../ui/CaEmptyState.vue'

/**
 * The full log surface: search, live tail and Insights over any combination of
 * the account's discovered log groups.
 *
 * Groups come from the scanned graph rather than from DescribeLogGroups over
 * the whole account. That keeps the picker to groups that belong to something
 * on the diagram, which is the question this view exists to answer — an account
 * has hundreds of groups and almost none of them are the one you want.
 */

const graph = useGraphStore()

type Mode = 'search' | 'tail' | 'insights'
const mode = ref<Mode>('search')

/**
 * Selection order matters, so this is a list rather than a set: the region is
 * taken from the first group the user picked. Deriving it from the sorted list
 * instead would mean selecting a group could silently switch the region away
 * from the one already chosen, and drop the earlier selection.
 */
const selected = ref<string[]>([])
const range = ref<(typeof LOG_TIME_RANGES)[number]>(LOG_TIME_RANGES[1])
const pattern = ref('')

const searchResult = ref<LogQueryResponse | null>(null)
const insightsResult = ref<InsightsResponse | null>(null)
const tailEvents = ref<LogEvent[]>([])
const tailing = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const query = ref(INSIGHTS_TEMPLATES[0]?.query ?? '')

let stopTail: (() => void) | null = null

/** Every log group any scanned node writes to, de-duplicated. */
const groups = computed<LogGroupRef[]>(() => {
  const byName = new Map<string, LogGroupRef>()
  for (const node of graph.graph?.nodes ?? []) {
    for (const name of node.logGroups) {
      if (byName.has(name)) continue
      byName.set(name, {
        name,
        kind: kindOf(name),
        region: node.region === 'global' ? 'us-east-1' : node.region,
        exists: true,
        hint: null,
        storedBytes: null,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
})

function kindOf(name: string): string {
  if (name.startsWith('/aws/rds/')) return 'rds'
  if (name.startsWith('/aws/lambda/')) return 'lambda'
  if (name.startsWith('aws-waf-logs-')) return 'waf'
  if (name.startsWith('/aws/ecs/')) return 'ecs'
  return 'generic'
}

/** The region of the selected groups; tail and Insights are single-region. */
const region = computed(() => {
  const first = selected.value[0]
  return groups.value.find((group) => group.name === first)?.region ?? 'us-east-1'
})

const selectedKinds = computed(() =>
  groups.value.filter((group) => selected.value.includes(group.name)).map((group) => group.kind),
)

const templates = computed(() => {
  const matching = templatesForKinds(selectedKinds.value)
  return matching.length > 0 ? matching : INSIGHTS_TEMPLATES
})

/**
 * Groups outside the chosen region, which tail and Insights cannot include.
 * Named rather than silently dropped, so a missing group is explained.
 */
const crossRegion = computed(() =>
  groups.value.filter(
    (group) => selected.value.includes(group.name) && group.region !== region.value,
  ),
)

const chosen = computed(() =>
  groups.value
    .filter((group) => selected.value.includes(group.name) && group.region === region.value)
    .map((group) => group.name),
)

function toggle(name: string): void {
  selected.value = selected.value.includes(name)
    ? selected.value.filter((entry) => entry !== name)
    : [...selected.value, name]
}

async function runSearch(): Promise<void> {
  if (chosen.value.length === 0) return
  loading.value = true
  error.value = null
  const end = Date.now()
  try {
    searchResult.value = await api.queryLogs({
      logGroups: chosen.value,
      region: region.value,
      start: end - range.value.ms,
      end,
      filterPattern: pattern.value,
      limit: 1000,
    })
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function runInsights(): Promise<void> {
  if (chosen.value.length === 0 || query.value.trim().length === 0) return
  loading.value = true
  error.value = null
  const end = Date.now()
  try {
    insightsResult.value = await api.queryInsights({
      logGroups: chosen.value,
      region: region.value,
      query: query.value,
      start: end - range.value.ms,
      end,
      limit: 1000,
    })
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function startTail(): void {
  if (chosen.value.length === 0) return
  stopTailing()
  error.value = null
  tailEvents.value = []
  tailing.value = true
  stopTail = streamTail(
    { logGroups: chosen.value, region: region.value, filterPattern: pattern.value },
    {
      onEvents: (events) => {
        // Bounded: a busy group would otherwise grow this array without limit
        // until the tab runs out of memory.
        tailEvents.value = [...tailEvents.value, ...events].slice(-2000)
      },
      onError: (message) => {
        error.value = message
        stopTailing()
      },
    },
  )
}

function stopTailing(): void {
  stopTail?.()
  stopTail = null
  tailing.value = false
}

watch(mode, (next) => {
  if (next !== 'tail') stopTailing()
})
onBeforeUnmount(stopTailing)

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

function formatBytesScanned(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.round(bytes / 1000)} KB`
}

const rows = computed(() => (mode.value === 'tail' ? tailEvents.value : searchResult.value?.events ?? []))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col px-5 py-4">
    <div class="mb-3 flex items-center gap-2">
      <div class="flex items-center gap-1">
        <button
          v-for="option in (['search', 'tail', 'insights'] as Mode[])"
          :key="option"
          type="button"
          class="h-[26px] cursor-pointer rounded-[6px] border px-[10px] text-[11.5px] capitalize transition-colors"
          :class="
            mode === option
              ? 'border-border2 bg-raise text-text'
              : 'border-border bg-transparent text-muted hover:text-text'
          "
          @click="mode = option"
        >
          {{ option === 'tail' ? 'Live tail' : option }}
        </button>
      </div>
      <span class="ml-auto text-[11px] text-faint">
        {{ chosen.length }} of {{ groups.length }} groups · {{ region }}
      </span>
    </div>

    <CaEmptyState
      v-if="groups.length === 0"
      title="No log groups discovered"
      description="Run a scan first. Log groups are collected from the resources that write to them, so the picker only lists groups belonging to something on the diagram."
    />

    <template v-else>
      <div class="mb-2 flex max-h-[84px] flex-wrap gap-[5px] overflow-auto">
        <button
          v-for="group in groups"
          :key="group.name"
          type="button"
          class="max-w-[280px] truncate rounded-[6px] border px-[7px] py-[3px] font-mono text-[10.5px] transition-colors"
          :class="
            selected.includes(group.name)
              ? 'border-border2 bg-raise text-text'
              : 'border-border bg-transparent text-faint hover:text-muted'
          "
          :title="`${group.name} (${group.region})`"
          @click="toggle(group.name)"
        >
          {{ group.name }}
        </button>
      </div>

      <p v-if="crossRegion.length > 0" class="mb-2 text-[11px] text-warn">
        {{ crossRegion.length === 1 ? '1 selected group is' : `${crossRegion.length} selected groups are` }}
        in another region and not included — CloudWatch queries one region at a time.
        The region follows the first group you selected.
      </p>

      <div class="mb-2 flex items-center gap-[6px]">
        <input
          v-if="mode !== 'insights'"
          v-model="pattern"
          type="text"
          :placeholder="
            mode === 'tail'
              ? 'Filter the stream by substring'
              : 'Search text, or a { $.level = &quot;ERROR&quot; } pattern'
          "
          class="h-[26px] min-w-0 flex-1 rounded-[6px] border border-border bg-panel px-[8px] text-[11.5px] text-text placeholder:text-faint focus:border-border2 focus:outline-none"
          @keydown.enter="mode === 'search' ? runSearch() : undefined"
        />
        <select
          v-else
          class="h-[26px] min-w-0 flex-1 rounded-[6px] border border-border bg-panel px-[6px] text-[11.5px] text-text focus:border-border2 focus:outline-none"
          @change="query = ($event.target as HTMLSelectElement).value"
        >
          <option v-for="template in templates" :key="template.id" :value="template.query">
            {{ template.label }} — {{ template.description }}
          </option>
        </select>

        <button
          v-for="option in LOG_TIME_RANGES"
          v-show="mode !== 'tail'"
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
          class="h-[26px] shrink-0 cursor-pointer rounded-[6px] border border-border2 bg-raise px-[11px] text-[11px] text-text disabled:opacity-50"
          :disabled="loading || chosen.length === 0"
          @click="
            mode === 'search' ? runSearch() : mode === 'insights' ? runInsights() : tailing ? stopTailing() : startTail()
          "
        >
          {{ loading ? '…' : mode === 'tail' ? (tailing ? 'Stop' : 'Start') : 'Run' }}
        </button>
      </div>

      <textarea
        v-if="mode === 'insights'"
        v-model="query"
        rows="6"
        spellcheck="false"
        class="mb-2 w-full resize-y rounded-[6px] border border-border bg-panel px-[9px] py-[7px] font-mono text-[11px] leading-[1.55] text-text focus:border-border2 focus:outline-none"
      />

      <CaEmptyState v-if="error" tone="error" title="Logs" :description="error" />

      <!-- Insights results -->
      <div
        v-else-if="mode === 'insights' && insightsResult"
        class="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border bg-panel2"
      >
        <p
          v-if="insightsResult.error"
          class="border-b border-border px-[10px] py-[7px] text-[11.5px] text-warn"
        >
          {{ insightsResult.error }}
        </p>
        <p
          v-if="insightsResult.statistics"
          class="border-b border-border px-[10px] py-[6px] text-[11px] text-faint"
        >
          {{ insightsResult.statistics.recordsMatched.toLocaleString() }} matched ·
          {{ insightsResult.statistics.recordsScanned.toLocaleString() }} scanned ·
          {{ formatBytesScanned(insightsResult.statistics.bytesScanned) }}
        </p>
        <table v-if="insightsResult.rows.length > 0" class="w-full text-left">
          <thead>
            <tr class="border-b border-border">
              <th
                v-for="column in insightsResult.columns"
                :key="column"
                class="px-[10px] py-[6px] font-mono text-[10.5px] font-medium text-muted"
              >
                {{ column }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in insightsResult.rows"
              :key="index"
              class="border-b border-border/50 last:border-b-0"
            >
              <td
                v-for="column in insightsResult.columns"
                :key="column"
                class="px-[10px] py-[5px] font-mono text-[10.5px] text-text"
              >
                {{ row[column] ?? '' }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-[10px] py-[9px] text-[11.5px] text-faint">
          The query completed and matched nothing in this window.
        </p>
      </div>

      <!-- Search and tail rows -->
      <div
        v-else-if="mode !== 'insights'"
        class="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border bg-panel2"
      >
        <p
          v-if="searchResult?.truncated && mode === 'search'"
          class="border-b border-border px-[10px] py-[6px] text-[11px] text-warn"
        >
          Showing the most recent {{ rows.length }} matches — there were more in this window.
        </p>
        <div
          v-for="event in rows"
          :key="event.id"
          class="flex gap-[8px] border-b border-border/50 px-[10px] py-[4px] font-mono text-[10.5px] leading-[1.5] last:border-b-0"
        >
          <span class="shrink-0 text-faint">{{ time(event.timestamp) }}</span>
          <span class="min-w-0 flex-1 break-all" :class="severityClass(event)">{{
            event.message
          }}</span>
        </div>
        <p v-if="rows.length === 0" class="px-[10px] py-[9px] text-[11.5px] text-faint">
          {{
            mode === 'tail'
              ? tailing
                ? 'Connected. Waiting for new events…'
                : 'Select groups and press Start to stream new events.'
              : 'No results yet. Press Run.'
          }}
        </p>
      </div>
    </template>
  </div>
</template>
