<script setup lang="ts">
import { computed } from 'vue'
import { stateTone } from '@/lib/utils'

const props = withDefaults(defineProps<{ state: string; big?: boolean }>(), { big: false })

const color = computed(() => {
  const tone = stateTone(props.state)
  return tone === 'faint' ? 'var(--ca-faint)' : tone === 'ok' ? 'var(--ca-ok)' : 'var(--ca-warn)'
})
</script>

<template>
  <span
    class="inline-flex items-center rounded-full border text-[10.5px] font-medium capitalize"
    :class="big ? 'px-2 py-[2px]' : 'px-[7px] py-[2px]'"
    :style="{ borderColor: color, color }"
  >
    {{ state }}
  </span>
</template>
