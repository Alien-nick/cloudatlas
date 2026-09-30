<script setup lang="ts">
import { computed } from 'vue'
import { SIM_CATALOG, type SimResourceType } from '@cloudatlas/shared'
import { useSimulationStore } from '@/stores/simulation'
import { SIM_DRAG_TYPE } from '@/lib/simPlacement'

/**
 * The resources a simulation can add, as tiles. Drag one onto the diagram to
 * place it where it is dropped; click one to add it to `targetId` — the
 * selected subnet or VPC — or, without one, to the first sensible place.
 * Either way it is added with defaults, selected, and shown on the canvas.
 */

const props = defineProps<{ targetId?: string | null }>()
const sim = useSimulationStore()

const target = computed(() => sim.current?.graph.nodes.find((node) => node.id === props.targetId) ?? null)

/** Inside a subnet only what lives in one; inside a VPC also subnets. */
const options = computed(() =>
  SIM_CATALOG.filter((entry) => {
    if (target.value?.type === 'subnet') return entry.placement === 'subnet'
    if (target.value?.type === 'vpc') return entry.placement !== 'region'
    return true
  }),
)

const GLYPH: Record<SimResourceType, string> = {
  vpc: 'VPC',
  subnet: 'SN',
  ec2: 'EC2',
  rds: 'RDS',
  elasticache: 'EC',
  alb: 'ALB',
  'nat-gateway': 'NAT',
  'ecs-task': 'ECS',
  lambda: 'λ',
  s3: 'S3',
  sqs: 'SQS',
}

function onDragStart(event: DragEvent, type: SimResourceType): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(SIM_DRAG_TYPE, type)
  event.dataTransfer.effectAllowed = 'copy'
  sim.draggingType = type
  // The dragged image is the tile itself, so it reads as the thing being placed.
  const tile = (event.currentTarget as HTMLElement).querySelector('[data-glyph]')
  if (tile) event.dataTransfer.setDragImage(tile, 14, 11)
}
</script>

<template>
  <div class="grid grid-cols-2 gap-[5px]">
    <button
      v-for="entry in options"
      :key="entry.type"
      type="button"
      draggable="true"
      class="group flex cursor-grab items-center gap-[7px] rounded-[7px] border border-border bg-panel2 px-[7px] py-[6px] text-left text-[11px] text-muted transition-colors hover:border-text hover:text-text active:cursor-grabbing"
      :title="target ? `Add to ${target.name}` : 'Drag onto the diagram, or click to add'"
      @dragstart="onDragStart($event, entry.type)"
      @dragend="sim.draggingType = null"
      @click="sim.quickAdd(entry.type, targetId ?? null)"
    >
      <span
        data-glyph
        class="flex h-[22px] w-[28px] shrink-0 items-center justify-center rounded-[5px] border border-border2 font-mono text-[9px] font-bold text-text"
      >
        {{ GLYPH[entry.type] }}
      </span>
      <span class="min-w-0 truncate">{{ entry.label }}</span>
    </button>
  </div>
</template>
