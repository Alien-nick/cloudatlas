<script setup lang="ts">
import type { SimChange } from '@cloudatlas/shared'
import { useSimulationStore } from '@/stores/simulation'

/** Every change in order, each one individually undoable. */

const sim = useSimulationStore()

function nameOf(id: string): string {
  const added = sim.changes.find((change) => change.op === 'add' && change.resource.id === id)
  if (added?.op === 'add') return added.resource.name
  return sim.current?.graph.nodes.find((node) => node.id === id)?.name ?? sim.current?.removed.find((entry) => entry.id === id)?.name ?? id
}

function describe(change: SimChange): { verb: string; text: string } {
  switch (change.op) {
    case 'add':
      return { verb: 'Add', text: `${change.resource.name} (${change.resource.type})` }
    case 'update':
      return { verb: 'Edit', text: `${nameOf(change.nodeId)}: ${Object.entries(change.settings).map(([k, v]) => `${k} = ${v}`).join(', ')}` }
    case 'remove':
      return { verb: 'Remove', text: nameOf(change.nodeId) }
    case 'connect':
      return { verb: 'Connect', text: `${nameOf(change.source)} → ${nameOf(change.target)}${change.port === null ? '' : ` :${change.port}`}` }
    case 'disconnect':
      return { verb: 'Disconnect', text: change.connectionId }
  }
}
</script>

<template>
  <div>
    <div class="ca-eyebrow mb-2">Changes ({{ sim.changes.length }})</div>
    <p v-if="sim.changes.length === 0" class="text-[11.5px] text-faint">Nothing changed yet. Add a resource to start.</p>
    <ol class="flex flex-col gap-[3px]">
      <li v-for="(change, index) in sim.changes" :key="index" class="group flex items-start gap-2 text-[11px]">
        <span class="w-[58px] shrink-0 font-semibold text-muted">{{ describe(change).verb }}</span>
        <span class="min-w-0 flex-1 break-words text-text">{{ describe(change).text }}</span>
        <button
          type="button"
          class="shrink-0 cursor-pointer text-[10.5px] text-faint opacity-0 hover:text-bad group-hover:opacity-100"
          title="Undo this change"
          @click="sim.discard(index)"
        >
          undo
        </button>
      </li>
    </ol>
  </div>
</template>
