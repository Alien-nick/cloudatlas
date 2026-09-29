<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { formatMetricValue, type MetricDef, type MetricSeries } from '@cloudatlas/shared'
import {
  formatAxisValues,
  readTheme,
  toChartData,
  withAlpha,
  yRange,
} from '@/lib/chart'

const props = withDefaults(
  defineProps<{
    series: MetricSeries
    def: MetricDef
    color: string
    height?: number
    /** Epoch ms at which an incident began, shaded on the plot. */
    anomalyFrom?: number | null
    /** Charts sharing a key share a cursor. */
    syncGroup?: string | null
  }>(),
  { height: 128, anomalyFrom: null, syncGroup: null },
)

const host = ref<HTMLDivElement | null>(null)
const chart = shallowRef<uPlot | null>(null)
const hovered = ref<{ value: number | null; timestamp: number } | null>(null)

let observer: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

/**
 * Shade the incident window.
 *
 * Drawn as a plugin rather than as a second series so it sits behind the line
 * and does not appear in the cursor readout as a value the user can hover.
 */
function anomalyPlugin(): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        const from = props.anomalyFrom
        if (from === null) return
        const theme = readTheme()
        const startX = u.valToPos(from / 1000, 'x', true)
        const endX = u.bbox.left + u.bbox.width
        if (!Number.isFinite(startX) || startX >= endX) return

        const ctx = u.ctx
        ctx.save()
        ctx.fillStyle = theme.anomaly
        const left = Math.max(startX, u.bbox.left)
        ctx.fillRect(left, u.bbox.top, endX - left, u.bbox.height)
        ctx.restore()
      },
    },
  }
}

function build(): void {
  const element = host.value
  if (!element) return
  destroy()

  const theme = readTheme()
  const width = element.clientWidth || 300
  const range = yRange(props.series.values, props.def)

  const options: uPlot.Options = {
    width,
    height: props.height,
    // The header already names the metric; a title inside the plot would only
    // repeat it and cost vertical space.
    title: undefined,
    cursor: {
      y: false,
      points: { size: 5 },
      ...(props.syncGroup ? { sync: { key: props.syncGroup, setSeries: false } } : {}),
    },
    legend: { show: false },
    padding: [8, 4, 0, 0],
    scales: {
      x: { time: true },
      y: range ? { range: () => range } : {},
    },
    axes: [
      {
        stroke: theme.text,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid, width: 1 },
        font: '10px ui-sans-serif, system-ui, sans-serif',
        size: 26,
      },
      {
        stroke: theme.text,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { show: false },
        font: '10px ui-sans-serif, system-ui, sans-serif',
        size: 42,
        values: (_u, splits) => formatAxisValues(splits, props.def),
      },
    ],
    series: [
      {
        // x axis: value shown in the hover readout.
        value: (_u, raw) =>
          raw === null ? '—' : new Date(raw * 1000).toLocaleTimeString(),
      },
      {
        label: props.series.label,
        stroke: props.color,
        width: 1.5,
        fill: withAlpha(props.color, 0.14),
        // False is the point: a null is a window CloudWatch had no data for,
        // and joining across it would draw a line that was never measured.
        spanGaps: false,
        points: { show: false },
      },
    ],
    plugins: [anomalyPlugin()],
    hooks: {
      setCursor: [
        (u: uPlot) => {
          const index = u.cursor.idx
          if (index === null || index === undefined) {
            hovered.value = null
            return
          }
          // Already scaled into display units when the data was built.
          const value = u.data[1]?.[index]
          const timestamp = u.data[0]?.[index]
          if (timestamp === undefined) {
            hovered.value = null
            return
          }
          hovered.value = {
            value: value === null || value === undefined ? null : Number(value),
            timestamp: Number(timestamp) * 1000,
          }
        },
      ],
    },
  }

  chart.value = new uPlot(options, toChartData(props.series, props.def.scale ?? 1), element)
}

function destroy(): void {
  chart.value?.destroy()
  chart.value = null
  hovered.value = null
}

function resize(): void {
  const element = host.value
  if (!element || !chart.value) return
  chart.value.setSize({ width: element.clientWidth || 300, height: props.height })
}

onMounted(() => {
  build()
  observer = new ResizeObserver(resize)
  if (host.value) observer.observe(host.value)

  // uPlot draws to a canvas, so it cannot pick up a CSS variable change the way
  // the rest of the UI does. Rebuild when the theme attribute flips.
  themeObserver = new MutationObserver(build)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  })
})

onBeforeUnmount(() => {
  observer?.disconnect()
  themeObserver?.disconnect()
  destroy()
})

// New data for the same metric updates in place; anything structural rebuilds.
watch(
  () => props.series,
  (next) => {
    if (!chart.value) {
      build()
      return
    }
    const range = yRange(next.values, props.def)
    const yScale = chart.value.scales.y
    if (range && yScale) yScale.range = () => range
    chart.value.setData(toChartData(next, props.def.scale ?? 1))
  },
)

watch(
  () => [props.def.name, props.color, props.height, props.syncGroup] as const,
  () => build(),
)

defineExpose({ hovered })
</script>

<template>
  <div class="relative">
    <div ref="host" class="ca-chart w-full" />
    <div
      v-if="hovered"
      class="pointer-events-none absolute right-0 top-0 rounded-[5px] border border-border2 bg-panel px-[6px] py-[2px] font-mono text-[10.5px] text-text shadow-sm"
    >
      {{ formatMetricValue(hovered.value, series.unit) }}
      <span class="text-faint">
        · {{ new Date(hovered.timestamp).toLocaleTimeString() }}
      </span>
    </div>
  </div>
</template>

<style>
/* uPlot ships light-theme defaults; only the cursor line needs overriding to
   sit on a dark panel. Everything else is set through the options above. */
.ca-chart .u-cursor-x,
.ca-chart .u-cursor-y {
  border-color: var(--ca-border2);
}
.ca-chart .u-select {
  background: rgba(139, 148, 158, 0.12);
}
</style>
