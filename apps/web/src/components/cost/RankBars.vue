<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * A ranking of one measure: one hue, bars against the largest, value labelled
 * at the end. Colour would only restate the length, so there is none beyond
 * the single hue; the value text carries the number.
 */

export interface RankRow {
  key: string
  label: string
  amount: number
  /** Secondary text under the label, e.g. "vs $120 last month". */
  sub?: string
  /** Makes the row a button, e.g. to open a resource. */
  onClick?: () => void
}

const props = withDefaults(defineProps<{ rows: RankRow[]; limit?: number; format: (value: number) => string }>(), {
  limit: 8,
})

const expanded = ref(false)
const shown = computed(() => (expanded.value ? props.rows : props.rows.slice(0, props.limit)))
const max = computed(() => Math.max(1e-9, ...props.rows.map((row) => row.amount)))
</script>

<template>
  <div>
    <ul class="flex flex-col gap-[9px]">
      <li v-for="row in shown" :key="row.key">
        <component
          :is="row.onClick ? 'button' : 'div'"
          :type="row.onClick ? 'button' : undefined"
          class="block w-full text-left"
          :class="row.onClick ? 'cursor-pointer rounded-[5px] hover:bg-raise/60' : ''"
          :title="`${row.label}: ${format(row.amount)}`"
          @click="row.onClick?.()"
        >
          <div class="mb-[4px] flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-[12px] text-text">{{ row.label }}</span>
            <span class="shrink-0 font-mono text-[12px] text-text">{{ format(row.amount) }}</span>
          </div>
          <div class="flex h-[8px] w-full gap-[2px]">
            <span
              class="h-full rounded-[4px] bg-[var(--ca-network)]"
              :style="{ width: `${Math.max(0.6, (row.amount / max) * 100)}%` }"
            />
          </div>
          <div v-if="row.sub" class="mt-[3px] text-[10.5px] text-faint">{{ row.sub }}</div>
        </component>
      </li>
    </ul>
    <button
      v-if="rows.length > limit"
      type="button"
      class="mt-[10px] cursor-pointer text-[11.5px] text-muted hover:text-text"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show fewer' : `Show all ${rows.length}` }}
    </button>
  </div>
</template>
