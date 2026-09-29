<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  findMetricDef,
  formatMetricValue,
  primaryMetricsFor,
  type GraphNode,
  type MetricDef,
  type MetricSeries,
} from '@cloudatlas/shared'
import { api, ApiError, streamMetrics } from '@/lib/api'
import { useHealthStore } from '@/stores/health'
import { categoryColor } from '@/lib/utils'
import { syncKeyFor, toDisplay } from '@/lib/chart'
import CaChart from '../ui/CaChart.vue'
import CaEmptyState from '../ui/CaEmptyState.vue'

const props = defineProps<{ node: GraphNode }>()
const health = useHealthStore()

const RANGES = [
  // 15 minutes is the freshest CloudWatch can be for a standard metric: it
  // picks a 60-second period, and a 60-second bucket is complete a minute
  // after it starts. Longer ranges pick coarser buckets, and a coarse bucket
  // is inherently behind by its own width.
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60_000 },
] as const

const range = ref<(typeof RANGES)[number]>(RANGES[0])
const live = ref(true)
const series = ref<MetricSeries[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
/** Age of the newest datapoint, as reported by the server. */
const lagMs = ref<number | null>(null)

/**
 * How stale the newest datapoint is.
 *
 * Shown because "live" without a number invites the reader to assume now.
 * CloudWatch publishes on a period and adds an ingestion delay on top, so a
 * chart is routinely a minute or two behind even when everything is working —
 * and knowing which is the difference between "the spike stopped" and "the
 * spike has not been reported yet".
 */
const freshness = computed(() => {
  if (lagMs.value === null) return null
  const seconds = Math.round(lagMs.value / 1000)
  if (seconds < 90) return `${seconds}s behind`
  return `${Math.round(seconds / 60)}m behind`
})

const period = computed(() => series.value[0]?.period ?? null)

/**
 * Whether the lag is explained by the bucket width rather than by CloudWatch.
 *
 * A 15-minute bucket cannot be complete until fifteen minutes have passed, so
 * a 7-day chart is structurally behind by at least its own resolution. Saying
 * "22m behind" without that makes it look like something is broken, when the
 * fix is simply a shorter range.
 */
const lagIsBucketWidth = computed(() => {
  const size = period.value
  if (size === null || lagMs.value === null) return false
  return size > 60 && lagMs.value <= size * 1000 * 2.5
})

const freshnessTitle = computed(() => {
  if (lagMs.value === null) return 'CloudWatch resolution'
  if (lagIsBucketWidth.value) {
    return (
      `Age of the newest complete datapoint. At this range CloudWatch buckets into ` +
      `${period.value}s, and a bucket is not complete until that long has passed — so most ` +
      'of this lag is the bucket width. Pick a shorter range for 60-second buckets.'
    )
  }
  return 'Age of the newest datapoint CloudWatch has published'
})

let stopStream: (() => void) | null = null

const catalogued = computed(() => primaryMetricsFor(props.node.type))

/**
 * Only shade a metric the incident actually names. The old sparkline shaded
 * every chart on the node from the earliest incident onward, which implied a
 * connection between, say, a WAF surge and disk IOPS that nothing had checked.
 */
function anomalyFor(item: MetricSeries): number | null {
  const findings = health.findingsByNode.get(props.node.id) ?? []
  const match = findings.filter((f) => f.metric === item.metricName).map((f) => f.startedAt)
  if (match.length === 0) return null
  const start = Math.min(...match)
  const first = item.timestamps[0]
  const last = item.timestamps[item.timestamps.length - 1]
  if (first === undefined || last === undefined) return null
  return start >= last ? null : Math.max(start, first)
}

function defFor(item: MetricSeries): MetricDef {
  return (
    findMetricDef(props.node.type, item.metricName) ?? {
      name: item.metricName,
      namespace: item.namespace,
      label: item.label,
      unit: item.unit,
      stat: item.stat,
      group: 'Other',
    }
  )
}

const syncGroup = computed(() => syncKeyFor(props.node.id))

async function load(): Promise<void> {
  if (catalogued.value.length === 0) {
    series.value = []
    return
  }
  loading.value = series.value.length === 0
  error.value = null
  const end = Date.now()
  try {
    const response = await api.metrics({
      nodeId: props.node.id,
      metricNames: [],
      start: end - range.value.ms,
      end,
    })
    series.value = response.series
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

/**
 * Subscribe to server-pushed updates instead of polling on a timer.
 *
 * The old 15-second interval re-fetched a datapoint CloudWatch had not
 * replaced yet four times out of five — cost without freshness. The server
 * polls at the metric's own period and pushes only what is new.
 */
function restartStream(): void {
  stopStream?.()
  stopStream = null
  if (!live.value) return

  stopStream = streamMetrics(
    { nodeIds: [props.node.id], windowMs: range.value.ms },
    {
      onUpdate: (update) => {
        if (update.nodeId !== props.node.id) return
        series.value = update.series
        lagMs.value = update.lagMs
        loading.value = false
      },
      onError: (message) => {
        error.value = message
      },
    },
  )
}

watch(
  () => [props.node.id, range.value.id, live.value] as const,
  () => {
    series.value = []
    lagMs.value = null
    if (live.value) {
      // The stream pushes its first update immediately, so this covers the
      // initial load as well as everything after it.
      restartStream()
    } else {
      // Paused still shows the data as it stands; pausing should stop updates,
      // not blank the charts.
      stopStream?.()
      stopStream = null
      void load()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => stopStream?.())

function latest(item: MetricSeries): number | null {
  for (let i = item.values.length - 1; i >= 0; i--) {
    const value = item.values[i]
    // Scaled here so the headline agrees with the chart beneath it; the raw
    // value is what the detectors compare against.
    if (value !== null && value !== undefined) return toDisplay(value, defFor(item))
  }
  return null
}

/**
 * Change across the visible window, not between the last two datapoints.
 *
 * Point-to-point at 60-second resolution is mostly quantisation noise: a metric
 * sitting on a plateau reports "up 0.00", which looks like a reading and is
 * not one. Comparing against the start of the window answers the question the
 * range buttons imply — what has this done over the last hour.
 */
function delta(item: MetricSeries): { text: string; up: boolean } | null {
  const values = item.values.filter((v): v is number => v !== null)
  const last = values[values.length - 1]
  const first = values[0]
  if (values.length < 2 || last === undefined || first === undefined) return null

  const scale = defFor(item).scale ?? 1
  const change = (last - first) * scale
  const rendered = formatMetricValue(Math.abs(change), '')
  // Hide a change that rounds away to nothing rather than printing "▲ 0.00".
  if (Number.parseFloat(rendered.replace(/,/g, '')) === 0) return null
  return { text: `${change >= 0 ? '▲' : '▼'} ${rendered}`, up: change >= 0 }
}

/** Rising is not the same as worsening; the catalog says which is which. */
function deltaTone(item: MetricSeries): string {
  const change = delta(item)
  if (!change) return 'text-muted'
  const def = defFor(item)
  const bad = change.up ? def.higherIsWorse : def.lowerIsWorse
  return bad ? 'text-bad' : 'text-muted'
}

function colorFor(item: MetricSeries): string {
  const name = item.metricName
  if (/5XX|Error|Blocked|Dropped|Throttle|Failed/i.test(name)) return '#E7157B'
  return categoryColor(props.node.category)
}
</script>

<template>
  <div>
    <div class="mb-3 flex items-center gap-[7px]">
      <span class="h-[6px] w-[6px] rounded-full" :class="live ? 'bg-ok' : 'bg-faint'" />
      <span
        class="whitespace-nowrap text-[11.5px] text-muted"
        :title="freshnessTitle"
      >
        CloudWatch · {{ period ? `${period}s` : '—' }}
        <template v-if="freshness"> · {{ freshness }}</template>
        <template v-if="lagIsBucketWidth"> · mostly bucket width</template>
      </span>
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
        <button
          type="button"
          class="h-[24px] cursor-pointer rounded-[6px] border border-border2 bg-transparent px-[9px] text-[11px] text-muted hover:text-text"
          @click="live = !live"
        >
          {{ live ? 'Pause' : 'Resume' }}
        </button>
      </div>
    </div>

    <CaEmptyState
      v-if="catalogued.length === 0"
      title="No metrics for this resource type"
      :description="`CloudAtlas has no CloudWatch metric catalog entry for ${node.typeLabel}.`"
    />
    <CaEmptyState
      v-else-if="error"
      tone="error"
      title="Could not load metrics"
      :description="error"
    />
    <div v-else-if="loading" class="flex flex-col gap-3">
      <div
        v-for="n in catalogued.length"
        :key="n"
        class="h-[168px] animate-pulse rounded-[9px] border border-border bg-panel2"
      />
    </div>

    <div v-else class="flex flex-col gap-3">
      <div
        v-for="item in series"
        :key="`${item.metricName}:${item.label}`"
        class="rounded-[9px] border border-border bg-panel2 px-[11px] pb-[8px] pt-[10px]"
      >
        <div class="mb-[6px] flex items-baseline gap-2">
          <span class="text-[11.5px] text-muted">{{ item.label }}</span>
          <span class="ml-auto font-mono text-[13px] font-medium">{{
            formatMetricValue(latest(item), item.unit)
          }}</span>
          <span
            v-if="delta(item)"
            class="font-mono text-[10px]"
            :class="deltaTone(item)"
            >{{ delta(item)!.text }}</span
          >
        </div>
        <p v-if="item.unavailableReason" class="pb-2 text-[11.5px] leading-[1.5] text-faint">
          {{ item.unavailableReason }}
        </p>
        <CaChart
          v-else
          :series="item"
          :def="defFor(item)"
          :color="colorFor(item)"
          :anomaly-from="anomalyFor(item)"
          :sync-group="syncGroup"
        />
      </div>
    </div>
  </div>
</template>
