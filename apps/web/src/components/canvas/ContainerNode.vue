<script setup lang="ts">
import { useGraphStore } from '@/stores/graph'
import { computed } from 'vue'
import type { ContainerNodeData } from './nodeData'


const graph = useGraphStore()

const props = defineProps<{ data: ContainerNodeData }>()
const emit = defineEmits<{ toggle: [id: string] }>()

const type = computed(() => props.data.node.type)
const isPublicSubnet = computed(() => type.value === 'subnet' && props.data.node.isPublic === true)

/** Box treatment per container level, straight from the design. */
const boxStyle = computed(() => {
  switch (type.value) {
    case 'region':
      return {
        border: '1px solid var(--ca-border2)',
        borderRadius: '10px',
        background: 'rgba(127,140,155,0.035)',
      }
    case 'vpc':
      return {
        border: '1.5px dashed #8C4FFF',
        borderRadius: '10px',
        background: 'rgba(140,79,255,0.045)',
      }
    case 'az':
      return { border: '1px dashed var(--ca-border2)', borderRadius: '9px' }
    case 'subnet':
      return isPublicSubnet.value
        ? {
            border: '1px solid rgba(122,161,22,0.45)',
            borderRadius: '8px',
            background: 'rgba(122,161,22,0.075)',
          }
        : {
            border: '1px solid rgba(59,130,246,0.45)',
            borderRadius: '8px',
            background: 'rgba(59,130,246,0.075)',
          }
    default:
      return {}
  }
})

const labelColor = computed(() => {
  switch (type.value) {
    case 'vpc':
      return '#a77dff'
    case 'subnet':
      return isPublicSubnet.value ? '#93b83a' : '#6fa8ff'
    default:
      return 'var(--ca-muted)'
  }
})

const chip = computed(() => {
  if (type.value === 'region') return { letter: 'R', bg: 'var(--ca-aws-navy)' }
  if (type.value === 'vpc') return { letter: 'V', bg: '#8C4FFF' }
  return null
})
</script>

<template>
  <div class="relative h-full w-full" :style="boxStyle">
    <div
      class="absolute left-3 top-[8px] flex items-center gap-[7px] whitespace-nowrap"
      :class="type === 'lane' || type === 'az' ? 'ca-eyebrow !text-[10.5px]' : ''"
    >
      <span
        v-if="chip"
        class="flex h-[14px] w-[14px] items-center justify-center rounded-[4px] font-mono text-[7px] text-white"
        :style="{ background: chip.bg }"
        >{{ chip.letter }}</span
      >
      <span
        class="text-[11.5px] font-semibold"
        :style="{ color: labelColor }"
        :class="type === 'lane' || type === 'az' ? 'tracking-[.06em] uppercase text-[10.5px]' : ''"
        >{{ graph.displayName(data.node) }}</span
      >
      <span v-if="data.node.cidr" class="font-mono text-[11px] text-faint">{{
        data.node.cidr
      }}</span>
      <span
        v-if="type === 'vpc' || data.collapsed"
        class="rounded-full border border-border2 px-[6px] py-[1px] text-[10px] font-normal text-muted"
        >{{ data.resourceCount }} resources</span
      >
      <button
        v-if="data.collapsible"
        type="button"
        class="ml-[2px] h-[16px] cursor-pointer rounded-[4px] border border-border2 bg-panel px-[5px] text-[9px] leading-none text-muted hover:text-text"
        :title="data.collapsed ? 'Expand this VPC' : 'Collapse this VPC'"
        @click.stop="emit('toggle', data.node.id)"
      >
        {{ data.collapsed ? '+' : '−' }}
      </button>
    </div>
  </div>
</template>
