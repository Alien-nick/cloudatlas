<script setup lang="ts">
import { useGraphStore } from '@/stores/graph'
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'
import type { ResourceNodeData } from './nodeData'


const graph = useGraphStore()

const props = defineProps<{ data: ResourceNodeData }>()

const color = computed(() => nodeColor(props.data.node))
// "planned" is a simulated resource: not running yet, but not stopped either.
const isStopped = computed(() => !['running', 'available', 'active', 'deployed', 'ready', 'in-use', 'planned'].includes(props.data.node.state))

const ring = computed(() => {
  if (props.data.selected) return color.value
  if (props.data.simStatus === 'added') return 'var(--ca-ok)'
  if (props.data.simStatus === 'changed') return 'var(--ca-warn)'
  if (props.data.worstSeverity === 'critical') return 'var(--ca-bad)'
  if (props.data.worstSeverity === 'warning') return 'var(--ca-warn)'
  return null
})

const badgeLabel = computed(() =>
  props.data.findingCount > 1 ? String(props.data.findingCount) : '!',
)

// Eight invisible handles so an edge can leave from whichever side faces its
// partner — the canvas picks the pair after layout.
const HANDLES = [
  { id: 't', position: Position.Top },
  { id: 'b', position: Position.Bottom },
  { id: 'l', position: Position.Left },
  { id: 'r', position: Position.Right },
] as const
</script>

<template>
  <div
    class="flex w-[116px] flex-col items-center transition-opacity duration-150"
    :style="{ opacity: data.dimmed ? 0.22 : 1 }"
  >
    <div class="relative">
      <CaTile
        :abbr="data.node.abbr"
        :color="color"
        :node-type="data.node.type"
        :dimmed="isStopped"
        :ring="ring"
        :pulse="data.worstSeverity === 'critical'"
      />
      <div
        v-if="data.findingCount > 0"
        class="absolute -top-[6px] -right-[8px] rounded-full px-[5px] py-[1px] text-[9px] font-bold text-white"
        :style="{
          background: data.worstSeverity === 'critical' ? 'var(--ca-bad)' : 'var(--ca-warn)',
        }"
        :title="`${data.findingCount} open finding${data.findingCount === 1 ? '' : 's'}`"
      >
        {{ badgeLabel }}
      </div>
      <div
        v-if="data.simStatus"
        class="absolute -top-[7px] -left-[12px] rounded-full border px-[5px] py-[1px] text-[8.5px] font-bold tracking-wide"
        :style="{
          color: data.simStatus === 'added' ? 'var(--ca-ok)' : 'var(--ca-warn)',
          borderColor: data.simStatus === 'added' ? 'var(--ca-ok)' : 'var(--ca-warn)',
          background: 'var(--ca-panel)',
        }"
      >
        {{ data.simStatus === 'added' ? 'NEW' : 'EDITED' }}
      </div>
    </div>

    <div
      class="mt-[6px] max-w-[116px] truncate text-center text-[11.5px] leading-[1.25]"
      :class="[
        data.selected ? 'font-bold' : 'font-medium',
        isStopped ? 'text-faint' : 'text-text',
      ]"
      :title="data.node.name"
    >
      {{ graph.displayName(data.node) }}
    </div>
    <div
      v-if="data.node.subtitle"
      class="mt-[1px] max-w-[116px] truncate text-center font-mono text-[9.5px] leading-[1.2] text-faint"
    >
      {{ data.node.subtitle }}
    </div>

    <template v-for="handle in HANDLES" :key="handle.id">
      <Handle :id="`${handle.id}-src`" type="source" :position="handle.position" />
      <Handle :id="`${handle.id}-tgt`" type="target" :position="handle.position" />
    </template>
  </div>
</template>
