<script setup lang="ts">
import { computed } from 'vue'
import type { GraphNode, Saving } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useCostStore } from '@/stores/cost'
import { RISK, money } from '@/lib/cost'
import CaEmptyState from '../ui/CaEmptyState.vue'
import FixCommands from '../compliance/FixCommands.vue'

const props = defineProps<{ node: GraphNode }>()
const app = useAppStore()
const cost = useCostStore()

const lines = computed(() => (cost.report?.runRate.lines ?? []).filter((line) => line.nodeId === props.node.id))
const total = computed(() => cost.byNode.get(props.node.id) ?? null)
const unpriced = computed(() => cost.report?.runRate.unpriced.find((entry) => entry.nodeId === props.node.id))
const savings = computed(() => cost.savingsByNode.get(props.node.id) ?? [])

function script(saving: Saving): string {
  if (!saving.fix) return ''
  const header = [`# ${saving.title} — review before running; CloudAtlas does not run this`]
  if (saving.fix.needsInput) header.push('# Replace every <placeholder> with your own value first.')
  return `${[...header, ...saving.fix.commands].join('\n')}\n`
}

function openSavings(): void {
  cost.mode = 'savings'
  app.setView('cost')
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <CaEmptyState v-if="!cost.report" tone="pending" :title="cost.loading ? 'Looking up prices…' : 'No cost data yet'" />

    <template v-else>
      <section class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
        <div class="flex items-baseline gap-2">
          <span class="ca-eyebrow">Estimated run-rate</span>
          <span class="ml-auto font-mono text-[15px] font-semibold">
            {{ total === null ? '—' : money(total) }}<span v-if="total !== null" class="text-[11px] font-normal text-faint">/mo</span>
          </span>
        </div>
        <ul v-if="lines.length" class="mt-[8px] flex flex-col gap-[5px]">
          <li v-for="line in lines" :key="line.component" class="text-[11.5px]">
            <div class="flex gap-2">
              <span class="min-w-0 flex-1 text-text">{{ line.component }}</span>
              <span class="font-mono">{{ money(line.monthlyUsd) }}</span>
            </div>
            <div class="font-mono text-[10.5px] text-faint">{{ line.basis }}</div>
          </li>
        </ul>
        <p v-else-if="unpriced" class="mt-[6px] text-[11.5px] text-muted">{{ unpriced.reason }}</p>
        <p v-else class="mt-[6px] text-[11.5px] text-muted">Not a billed resource on its own.</p>
        <p class="mt-[8px] text-[10.5px] leading-[1.5] text-faint">
          On-demand list price for what is configured now; usage charges and discounts are not included.
        </p>
      </section>

      <section v-if="savings.length">
        <div class="mb-2 flex items-center">
          <span class="ca-eyebrow">Ways to save</span>
          <button type="button" class="ml-auto cursor-pointer text-[11px] text-muted hover:text-text" @click="openSavings">
            All savings ▸
          </button>
        </div>
        <div class="flex flex-col gap-[8px]">
          <article v-for="saving in savings" :key="saving.id" class="rounded-[8px] border border-border bg-panel2 px-[10px] py-[9px]">
            <div class="flex items-center gap-2">
              <span class="text-[10.5px]" :style="{ color: RISK[saving.risk].color }">
                {{ RISK[saving.risk].glyph }} {{ RISK[saving.risk].label }}
              </span>
              <span class="ml-auto font-mono text-[12px] font-semibold text-ok">
                {{ saving.monthlySavingsUsd === null ? '' : `${money(saving.monthlySavingsUsd)}/mo` }}
              </span>
            </div>
            <div class="mt-[3px] text-[12.5px] font-medium">{{ saving.title }}</div>
            <p v-if="saving.savingsNote" class="mt-[3px] text-[11px] text-muted">{{ saving.savingsNote }}</p>
            <p class="mt-[3px] text-[11.5px] leading-[1.5] text-muted">{{ saving.rationale }}</p>
            <FixCommands
              v-if="saving.fix && saving.fix.commands.length"
              class="mt-[8px]"
              :script="script(saving)"
              :caution="saving.fix.caution"
              :needs-input="saving.fix.needsInput"
            />
          </article>
        </div>
      </section>
    </template>
  </div>
</template>
