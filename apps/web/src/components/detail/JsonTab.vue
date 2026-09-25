<script setup lang="ts">
import { computed } from 'vue'
import type { GraphNode } from '@cloudatlas/shared'

const props = defineProps<{ node: GraphNode }>()

const json = computed(() => {
  try {
    return JSON.stringify(props.node.raw ?? props.node, null, 2)
  } catch {
    return '// This resource\'s describe output could not be serialised.'
  }
})
</script>

<template>
  <pre
    class="m-0 overflow-x-auto rounded-[8px] border border-border bg-panel2 p-3 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-all text-muted"
    >{{ json }}</pre
  >
</template>
