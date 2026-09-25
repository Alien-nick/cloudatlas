<script setup lang="ts">
import type { GraphNode } from '@cloudatlas/shared'
import CaEmptyState from '../ui/CaEmptyState.vue'

defineProps<{ node: GraphNode }>()
</script>

<template>
  <div v-if="node.tags.length > 0" class="flex flex-col">
    <div
      v-for="tag in node.tags"
      :key="tag.key"
      class="flex gap-3 border-b border-border py-2 last:border-b-0"
    >
      <div class="w-[112px] shrink-0 font-mono text-[11.5px] text-muted">{{ tag.key }}</div>
      <div class="min-w-0 flex-1 break-all font-mono text-[11.5px]">{{ tag.value }}</div>
    </div>
  </div>
  <CaEmptyState
    v-else
    title="No tags"
    description="This resource has no tags. Tag filters and environment chips will not match it."
  />
</template>
