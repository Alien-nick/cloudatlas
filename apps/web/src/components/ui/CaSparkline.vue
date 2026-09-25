<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    values: Array<number | null>
    color: string
    width?: number
    height?: number
    /** Shade the portion of the window an incident covers. */
    anomalyFrom?: number | null
  }>(),
  { width: 306, height: 42, anomalyFrom: null },
)

interface Point {
  x: number
  y: number
}

const usable = computed(() => props.values.filter((v): v is number => v !== null))

const scale = computed(() => {
  const values = usable.value
  if (values.length === 0) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || Math.abs(max) || 1
  return { min, max, span }
})

const points = computed<Point[]>(() => {
  const s = scale.value
  if (!s || props.values.length < 2) return []
  const step = props.width / (props.values.length - 1)
  const out: Point[] = []
  props.values.forEach((value, index) => {
    if (value === null) return
    out.push({
      x: index * step,
      y: props.height - ((value - s.min) / s.span) * (props.height - 6) - 3,
    })
  })
  return out
})

const linePath = computed(() =>
  points.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
)

const areaPath = computed(() => {
  const list = points.value
  if (list.length === 0) return ''
  const first = list[0]
  const last = list[list.length - 1]
  if (!first || !last) return ''
  return `${linePath.value} L${last.x.toFixed(1)},${props.height} L${first.x.toFixed(1)},${props.height} Z`
})

/** Left edge (in px) of the shaded anomaly window. */
const anomalyX = computed(() => {
  if (props.anomalyFrom === null) return null
  const ratio = Math.min(1, Math.max(0, props.anomalyFrom))
  return ratio * props.width
})
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    class="block w-full"
    role="img"
    aria-hidden="true"
  >
    <rect
      v-if="anomalyX !== null"
      :x="anomalyX"
      y="0"
      :width="width - anomalyX"
      :height="height"
      fill="rgba(242,85,90,.10)"
    />
    <!-- fill-opacity rather than an alpha suffix, so `color` can be a CSS
         variable as well as a hex literal. -->
    <path v-if="areaPath" :d="areaPath" :fill="color" fill-opacity="0.14" stroke="none" />
    <path v-if="linePath" :d="linePath" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" />
  </svg>
</template>
