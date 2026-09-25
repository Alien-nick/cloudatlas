<script setup lang="ts">
import { computed } from 'vue'
import {
  INTERNET_NODE_ID,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { nodeColor } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaTile from '../ui/CaTile.vue'

const props = defineProps<{ node: GraphNode }>()
const app = useAppStore()
const graph = useGraphStore()

interface Row {
  key: string
  peerId: string
  name: string
  abbr: string
  color: string
  nodeType: NodeType
  detail: string
  kind: GraphEdge['kind']
}

function toRows(edges: GraphEdge[], direction: 'in' | 'out'): Row[] {
  return edges.map((edge) => {
    const peerId = direction === 'in' ? edge.source : edge.target
    const peer = graph.nodeById.get(peerId)
    const label = edge.label ?? ''
    const detail =
      edge.kind === 'event'
        ? label
        : edge.kind === 'risk'
          ? `tcp/${label} from 0.0.0.0/0`
          : label
            ? `tcp/${label}`
            : edge.kind
    return {
      key: edge.id,
      peerId,
      name: peer?.name ?? (peerId === INTERNET_NODE_ID ? '0.0.0.0/0' : peerId),
      abbr: peer?.abbr ?? 'WWW',
      color: peer ? nodeColor(peer) : 'var(--ca-security)',
      nodeType: peer?.type ?? 'internet',
      detail,
      kind: edge.kind,
    }
  })
}

const connections = computed(() => graph.connectionsOf(props.node.id))
const inbound = computed(() => toRows(connections.value.inbound, 'in'))
const outbound = computed(() => toRows(connections.value.outbound, 'out'))

function open(peerId: string): void {
  if (!graph.nodeById.has(peerId)) return
  graph.select(peerId)
  app.detailTab = 'overview'
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <section v-for="group in [
      { label: 'Inbound', rows: inbound },
      { label: 'Outbound', rows: outbound },
    ]" :key="group.label">
      <div class="ca-eyebrow mb-[7px]">{{ group.label }}</div>
      <p v-if="group.rows.length === 0" class="text-[12px] text-faint">
        No {{ group.label.toLowerCase() }} connections were derived for this resource.
      </p>
      <button
        v-for="row in group.rows"
        :key="row.key"
        type="button"
        class="mb-[6px] flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] border bg-panel2 px-[9px] py-2 text-left transition-colors hover:border-border2"
        :class="row.kind === 'risk' ? 'border-bad/50' : 'border-border'"
        @click="open(row.peerId)"
      >
        <CaTile :abbr="row.abbr" :color="row.color" :node-type="row.nodeType" :size="22" :radius="5" />
        <span class="min-w-0 truncate text-[12.5px]">{{ row.name }}</span>
        <span
          class="ml-auto shrink-0 font-mono text-[10.5px]"
          :class="row.kind === 'risk' ? 'text-bad' : 'text-muted'"
          >{{ row.detail }}</span
        >
      </button>
    </section>

    <CaEmptyState
      v-if="inbound.length === 0 && outbound.length === 0"
      title="Unconnected resource"
      description="No traffic, security-group or event relationship was derived for this resource."
    />
  </div>
</template>
