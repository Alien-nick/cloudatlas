<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * Daily spend, one bar per day.
 *
 * A single series, so one hue and no legend; the card title names it. Hovering
 * a bar reads its day and amount out above the chart — the readout sits in
 * text ink, not the bar colour. A visually hidden table carries the same data
 * for screen readers.
 */

const props = defineProps<{ days: Array<{ key: string; amount: number }>; format: (value: number) => string }>()

const hovered = ref<number | null>(null)
const max = computed(() => Math.max(1e-9, ...props.days.map((day) => day.amount)))
const average = computed(() =>
  props.days.length === 0 ? 0 : props.days.reduce((sum, day) => sum + day.amount, 0) / props.days.length,
)

function label(key: string): string {
  const date = new Date(`${key}T00:00:00Z`)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const readout = computed(() => {
  const day = hovered.value === null ? undefined : props.days[hovered.value]
  return day ? `${label(day.key)} · ${props.format(day.amount)}` : `Daily average ${props.format(average.value)}`
})
</script>

<template>
  <div>
    <div class="mb-[8px] flex items-baseline gap-2">
      <span class="font-mono text-[12px] text-text">{{ readout }}</span>
      <span class="ml-auto font-mono text-[10.5px] text-faint">max {{ format(max) }}</span>
    </div>
    <div class="flex h-[120px] items-end gap-[2px] border-b border-border" @mouseleave="hovered = null">
      <button
        v-for="(day, index) in days"
        :key="day.key"
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-default items-end"
        :aria-label="`${label(day.key)}: ${format(day.amount)}`"
        @mouseenter="hovered = index"
        @focus="hovered = index"
      >
        <span
          class="w-full rounded-t-[4px] bg-[var(--ca-network)] transition-opacity"
          :class="hovered !== null && hovered !== index ? 'opacity-45' : ''"
          :style="{ height: `${Math.max(1.5, (day.amount / max) * 100)}%` }"
        />
      </button>
    </div>
    <div class="mt-[5px] flex justify-between font-mono text-[10.5px] text-faint">
      <span>{{ days[0] ? label(days[0].key) : '' }}</span>
      <span>{{ days.at(-1) ? label(days.at(-1)!.key) : '' }}</span>
    </div>
    <table class="sr-only">
      <caption>Daily spend</caption>
      <tr v-for="day in days" :key="day.key">
        <td>{{ day.key }}</td>
        <td>{{ format(day.amount) }}</td>
      </tr>
    </table>
  </div>
</template>
