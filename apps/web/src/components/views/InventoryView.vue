<script setup lang="ts">
import { computed, ref } from 'vue'
import { isContainerType, type GraphNode } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { formatCurrency, nodeColor } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaStatePill from '../ui/CaStatePill.vue'
import CaTile from '../ui/CaTile.vue'

const app = useAppStore()
const graph = useGraphStore()

type SortKey = 'name' | 'typeLabel' | 'region' | 'vpc' | 'state' | 'cost'

const sortKey = ref<SortKey>('name')
const sortDir = ref<'asc' | 'desc'>('asc')

const rows = computed(() =>
  graph.visibleNodes.filter((n) => !isContainerType(n.type) && n.type !== 'internet'),
)

/** The cost column is only meaningful when estimates were actually collected. */
const showCost = computed(
  () => app.info?.costEnabled === true || rows.value.some((n) => n.monthlyCostUsd !== null),
)

const columns = computed(() => {
  const base: Array<{ key: SortKey; label: string; align?: 'right' }> = [
    { key: 'name', label: 'Name' },
    { key: 'typeLabel', label: 'Type' },
    { key: 'region', label: 'Region' },
    { key: 'vpc', label: 'VPC' },
    { key: 'state', label: 'State' },
  ]
  const tail: Array<{ key: SortKey | 'tags'; label: string; align?: 'right' }> = [
    { key: 'tags', label: 'Tags' },
  ]
  if (showCost.value) tail.push({ key: 'cost', label: 'Monthly est.', align: 'right' })
  return [...base, ...tail]
})

function vpcName(node: GraphNode): string {
  if (!node.vpcId) return '—'
  return graph.nodeById.get(node.vpcId)?.name ?? node.vpcId
}

function sortValue(node: GraphNode, key: SortKey): string | number {
  switch (key) {
    case 'cost':
      return node.monthlyCostUsd ?? -1
    case 'vpc':
      return vpcName(node)
    default:
      return String(node[key] ?? '')
  }
}

const sorted = computed(() => {
  const direction = sortDir.value === 'asc' ? 1 : -1
  return [...rows.value].sort((a, b) => {
    const left = sortValue(a, sortKey.value)
    const right = sortValue(b, sortKey.value)
    if (left === right) return a.name.localeCompare(b.name)
    return left < right ? -direction : direction
  })
})

const total = computed(() =>
  rows.value.reduce((sum, node) => sum + (node.monthlyCostUsd ?? 0), 0),
)

function sortBy(key: SortKey | 'tags'): void {
  if (key === 'tags') return
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = key === 'cost' ? 'desc' : 'asc'
  }
}

function arrow(key: SortKey | 'tags'): string {
  if (key !== sortKey.value) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[38px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <span class="text-[12.5px] font-semibold">Inventory</span>
      <span class="text-[11.5px] text-faint">{{ graph.focusCount }}</span>
      <template v-if="showCost">
        <span class="ml-auto text-[11.5px] text-muted">Monthly est. total</span>
        <span class="font-mono text-[12px] font-semibold">{{ formatCurrency(total) }}</span>
      </template>
    </div>

    <div v-if="sorted.length === 0" class="flex flex-1 items-center justify-center">
      <CaEmptyState
        title="No resources match"
        description="Adjust the sidebar filters or scan another region."
      />
    </div>

    <div v-else class="flex-1 overflow-auto">
      <table class="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              class="sticky top-0 z-[2] h-[34px] cursor-pointer border-b border-border bg-panel2 px-[14px] text-[11px] font-semibold whitespace-nowrap text-muted"
              :class="column.align === 'right' ? 'text-right' : 'text-left'"
              @click="sortBy(column.key)"
            >
              <span>{{ column.label }}</span>
              <span class="ml-[5px] text-[9px] text-faint">{{ arrow(column.key) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="node in sorted"
            :key="node.id"
            class="cursor-pointer"
            :class="graph.selectedId === node.id ? 'bg-raise' : 'hover:bg-raise/50'"
            @click="graph.select(node.id)"
          >
            <td class="h-[40px] border-b border-border px-[14px]">
              <div class="flex items-center gap-[9px]">
                <CaTile :abbr="node.abbr" :color="nodeColor(node)" :node-type="node.type" :size="22" :radius="5" />
                <span class="font-medium">{{ node.name }}</span>
                <span
                  v-if="node.health === 'critical' || node.health === 'warn'"
                  class="h-[6px] w-[6px] rounded-full"
                  :style="{
                    background: node.health === 'critical' ? 'var(--ca-bad)' : 'var(--ca-warn)',
                  }"
                />
              </div>
            </td>
            <td class="border-b border-border px-[14px] font-mono text-[11.5px] text-muted">
              {{ node.typeLabel }}
            </td>
            <td class="border-b border-border px-[14px] font-mono text-[11.5px] text-muted">
              {{ node.region }}
            </td>
            <td class="border-b border-border px-[14px] font-mono text-[11.5px] text-muted">
              {{ vpcName(node) }}
            </td>
            <td class="border-b border-border px-[14px]">
              <CaStatePill :state="node.state" />
            </td>
            <td class="border-b border-border px-[14px]">
              <div class="flex gap-[5px]">
                <span
                  v-for="tag in node.tags.slice(0, 2)"
                  :key="tag.key"
                  class="rounded-[5px] border border-border2 bg-chip px-[7px] py-[2px] font-mono text-[10.5px] whitespace-nowrap text-muted"
                  >{{ tag.key.toLowerCase() }}={{ tag.value }}</span
                >
              </div>
            </td>
            <td
              v-if="showCost"
              class="border-b border-border px-[14px] text-right font-mono text-[11.5px]"
            >
              {{ formatCurrency(node.monthlyCostUsd) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
