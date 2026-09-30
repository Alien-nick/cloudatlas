<script setup lang="ts">
import { computed } from 'vue'
import type { Saving } from '@cloudatlas/shared'
import { useGraphStore } from '@/stores/graph'
import { RISK, money } from '@/lib/cost'
import { nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'
import FixCommands from '../compliance/FixCommands.vue'

/** One savings suggestion: what, how much, how risky, and the commands. */

const props = defineProps<{ saving: Saving; rank?: number }>()
const emit = defineEmits<{ open: [nodeId: string] }>()
const graph = useGraphStore()

const node = computed(() => graph.nodeById.get(props.saving.nodeId))
const name = computed(() => (node.value ? graph.displayName(node.value) : props.saving.nodeId))

const script = computed(() => {
  const fix = props.saving.fix
  if (!fix) return ''
  const header = [`# ${props.saving.title} — ${name.value}; review before running, CloudAtlas does not run this`]
  if (fix.needsInput) header.push('# Replace every <placeholder> with your own value first.')
  return `${[...header, ...fix.commands].join('\n')}\n`
})
</script>

<template>
  <li class="rounded-[10px] border border-border bg-panel p-[14px]">
    <div class="flex items-start gap-[11px]">
      <span v-if="rank" class="mt-[1px] font-mono text-[12px] font-semibold text-faint">{{ rank }}</span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[13px] font-semibold">{{ saving.title }}</span>
          <span
            class="flex items-center gap-[4px] rounded-full border border-border2 px-[7px] text-[10.5px]"
            :style="{ color: RISK[saving.risk].color }"
          >
            <span class="text-[8px]">{{ RISK[saving.risk].glyph }}</span>{{ RISK[saving.risk].label }}
          </span>
          <span class="ml-auto font-mono text-[13px] font-semibold text-ok">
            {{ saving.monthlySavingsUsd === null ? '' : `${money(saving.monthlySavingsUsd)}/mo` }}
          </span>
        </div>
        <button
          type="button"
          class="mt-[6px] flex cursor-pointer items-center gap-[7px] text-left hover:underline"
          title="Open the resource's full page"
          @click="emit('open', saving.nodeId)"
        >
          <CaTile v-if="node" :abbr="node.abbr" :color="nodeColor(node)" :node-type="node.type" :size="18" :radius="4" />
          <span class="text-[12px] text-text">{{ name }}</span>
        </button>
        <p v-if="saving.savingsNote" class="mt-[5px] text-[11.5px] text-muted">
          <span class="font-semibold text-text">Saving:</span> {{ saving.savingsNote }}
        </p>
        <p class="mt-[5px] text-[12px] leading-[1.55] text-muted">{{ saving.rationale }}</p>
        <ul class="mt-[6px] flex flex-col gap-[2px]">
          <li v-for="(line, i) in saving.evidence" :key="i" class="font-mono text-[10.5px] text-faint">· {{ line }}</li>
        </ul>
        <FixCommands
          v-if="saving.fix && saving.fix.commands.length > 0"
          class="mt-[9px]"
          :script="script"
          :caution="saving.fix.caution"
          :needs-input="saving.fix.needsInput"
        />
        <p v-else class="mt-[8px] text-[11.5px] text-muted">
          <span class="font-semibold text-text">No single command does this safely.</span>
          It needs a rebuild or a migration rather than a setting change.
        </p>
      </div>
    </div>
  </li>
</template>
