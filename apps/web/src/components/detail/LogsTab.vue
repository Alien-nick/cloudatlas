<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GraphNode, LogGroupRef } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import LogSearch from './LogSearch.vue'

const props = defineProps<{ node: GraphNode }>()

const groups = ref<LogGroupRef[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.node.id,
  async (nodeId) => {
    loading.value = true
    error.value = null
    groups.value = []
    try {
      groups.value = await api.logGroups(nodeId)
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <div class="ca-eyebrow mb-[9px]">Discovered log groups</div>

    <div v-if="loading" class="flex flex-col gap-2">
      <div v-for="n in 2" :key="n" class="h-[52px] animate-pulse rounded-[8px] bg-panel2" />
    </div>

    <CaEmptyState
      v-else-if="error"
      tone="error"
      title="Could not list log groups"
      :description="error"
    />

    <CaEmptyState
      v-else-if="groups.length === 0"
      title="No log groups"
      :description="`No CloudWatch log group is associated with this ${node.typeLabel}.`"
    />

    <div v-else class="flex flex-col gap-2">
      <div
        v-for="group in groups"
        :key="group.name"
        class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[9px]"
      >
        <div class="flex items-center gap-2">
          <span
            class="h-[6px] w-[6px] shrink-0 rounded-full"
            :class="group.exists ? 'bg-ok' : 'bg-faint'"
          />
          <span class="min-w-0 truncate font-mono text-[11px]" :title="group.name">{{
            group.name
          }}</span>
          <span class="ml-auto shrink-0 text-[10.5px] text-faint">{{ group.kind }}</span>
        </div>
        <p v-if="group.hint" class="mt-[5px] text-[11.5px] leading-[1.5] text-muted">
          {{ group.hint }}
        </p>
        <p v-else-if="group.storedBytes !== null" class="mt-[5px] text-[11px] text-faint">
          {{ formatBytes(group.storedBytes) }} stored
        </p>
      </div>
    </div>

    <LogSearch v-if="!loading && !error" :groups="groups" :region="node.region" />

    <div class="mt-4 rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
      <p class="text-[11.5px] leading-[1.55] text-muted">
        Live tail and the Logs Insights query editor arrive later in Milestone 4. Group discovery
        and search are live.
      </p>
    </div>
  </div>
</template>
