<script setup lang="ts">
import { computed } from 'vue'
import { useComplianceStore } from '@/stores/compliance'
import { useSimulationStore } from '@/stores/simulation'
import { money } from '@/lib/cost'

/**
 * What the simulation changes, against the snapshot. Each figure is the same
 * engine as the rest of CloudAtlas, run on both graphs and compared.
 */

const sim = useSimulationStore()
const compliance = useComplianceStore()
const impact = computed(() => sim.impact)

const nameOf = (id: string): string =>
  sim.current?.graph.nodes.find((node) => node.id === id)?.name ??
  sim.current?.removed.find((entry) => entry.id === id)?.name ??
  id
const isNew = (id: string): boolean => sim.current?.status[id] === 'added'

const delta = computed(() => (impact.value ? impact.value.cost.after - impact.value.cost.before : 0))

/** Only the frameworks this account is measured against, as chosen in Compliance. */
const frameworks = computed(() =>
  (impact.value?.compliance ?? []).filter((entry) => compliance.selected.includes(entry.framework as never)),
)

const routesToExisting = computed(() => (impact.value?.exposure.newlyReachable ?? []).filter((entry) => !isNew(entry.nodeId)))
const routesToNew = computed(() => (impact.value?.exposure.newlyReachable ?? []).filter((entry) => isNew(entry.nodeId)))

function pct(value: number | null): string {
  return value === null ? '—' : `${value}%`
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-2">
      <span class="ca-eyebrow">Impact</span>
      <span v-if="sim.impactLoading" class="text-[11px] text-faint">updating…</span>
    </div>

    <p v-if="!impact" class="text-[12px] text-muted">
      {{ sim.impactLoading ? 'Working out what this changes…' : 'Make a change to see its impact.' }}
    </p>

    <template v-else>
      <!-- Problems first: a change that no longer applies changes every figure below. -->
      <section v-if="sim.current?.problems.length" class="rounded-[8px] border border-warn/40 bg-panel2 px-[10px] py-[8px]">
        <div class="mb-[4px] text-[11.5px] font-semibold text-warn">Changes that no longer apply</div>
        <ul class="flex flex-col gap-[2px] text-[11px] text-muted">
          <li v-for="(problem, i) in sim.current.problems" :key="i">· {{ problem }}</li>
        </ul>
      </section>

      <section class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
        <div class="mb-[6px] flex items-baseline gap-2">
          <span class="text-[12px] font-semibold">Monthly cost</span>
          <span
            class="ml-auto font-mono text-[14px] font-semibold"
            :class="delta > 0.005 ? 'text-bad' : delta < -0.005 ? 'text-ok' : 'text-text'"
          >
            {{ delta > 0.005 ? '+' : '' }}{{ money(delta) }}
          </span>
        </div>
        <div class="font-mono text-[11px] text-muted">{{ money(impact.cost.before) }} → {{ money(impact.cost.after) }} estimated</div>
        <p v-if="impact.cost.message" class="mt-[6px] text-[11px] text-warn">{{ impact.cost.message }}</p>
        <ul class="mt-[6px] flex flex-col gap-[3px]">
          <li v-for="line in impact.cost.lines" :key="line.nodeId" class="flex gap-2 text-[11px]">
            <button type="button" class="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline" @click="sim.focus(line.nodeId)">
              {{ line.name }}
            </button>
            <span class="text-faint">{{ line.change }}</span>
            <span class="font-mono">{{ line.after - line.before > 0 ? '+' : '' }}{{ money(line.after - line.before) }}</span>
          </li>
        </ul>
        <p v-if="impact.cost.notEstimated.length" class="mt-[6px] text-[10.5px] text-faint">
          Not estimated (usage-billed): {{ impact.cost.notEstimated.map((entry) => nameOf(entry.nodeId)).join(', ') }}
        </p>
        <p class="mt-[6px] text-[10.5px] text-faint">List prices; usage and discounts not included.</p>
      </section>

      <section class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
        <div class="mb-[6px] text-[12px] font-semibold">Internet exposure</div>
        <p v-if="!impact.exposure.newlyReachable.length && !impact.exposure.noLongerReachable.length" class="text-[11.5px] text-muted">
          No new routes from the internet.
        </p>
        <div v-if="routesToExisting.length" class="mb-[8px]">
          <div class="mb-[3px] text-[11px] font-semibold text-bad">New routes to existing resources</div>
          <ul class="flex flex-col gap-[4px]">
            <li v-for="route in routesToExisting" :key="route.nodeId" class="text-[11px]">
              <button type="button" class="cursor-pointer font-medium hover:underline" @click="sim.focus(route.nodeId)">{{ nameOf(route.nodeId) }}</button>
              <div class="font-mono text-[10.5px] text-faint">internet → {{ route.path.map(nameOf).join(' → ') }}</div>
              <div class="text-[10.5px] text-faint">via: {{ route.entryReason }}</div>
            </li>
          </ul>
        </div>
        <div v-if="routesToNew.length">
          <div class="mb-[3px] text-[11px] font-semibold text-muted">Reachable new resources</div>
          <ul class="flex flex-col gap-[2px]">
            <li v-for="route in routesToNew" :key="route.nodeId" class="font-mono text-[10.5px] text-faint">
              internet → {{ route.path.map(nameOf).join(' → ') }}
            </li>
          </ul>
        </div>
        <div v-if="impact.exposure.noLongerReachable.length" class="mt-[8px]">
          <div class="mb-[3px] text-[11px] font-semibold text-ok">No longer reachable</div>
          <div class="text-[11px] text-muted">{{ impact.exposure.noLongerReachable.map((entry) => entry.name).join(', ') }}</div>
        </div>
      </section>

      <section v-for="entry in frameworks" :key="entry.framework" class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
        <div class="mb-[6px] flex items-baseline gap-2">
          <span class="text-[12px] font-semibold">{{ entry.frameworkName }}</span>
          <span class="ml-auto font-mono text-[12px]">
            {{ pct(entry.before) }} →
            <span :class="(entry.after ?? 0) < (entry.before ?? 0) ? 'text-bad' : (entry.after ?? 0) > (entry.before ?? 0) ? 'text-ok' : ''">{{ pct(entry.after) }}</span>
          </span>
        </div>
        <p v-if="!entry.newGaps.length && !entry.fixed.length" class="text-[11px] text-muted">No change.</p>
        <ul class="flex flex-col gap-[3px]">
          <li v-for="gap in entry.newGaps" :key="`gap-${gap.checkId}-${gap.nodeId}`" class="text-[11px]">
            <span class="text-bad">✕</span> {{ gap.checkTitle }} —
            <button type="button" class="cursor-pointer hover:underline" @click="sim.focus(gap.nodeId)">{{ nameOf(gap.nodeId) }}</button>
            <span class="ml-1 font-mono text-[10px] text-faint">{{ gap.controls.join(', ') }}</span>
          </li>
          <li v-for="fix in entry.fixed" :key="`fix-${fix.checkId}-${fix.nodeId}`" class="text-[11px] text-muted">
            <span class="text-ok">✓</span> {{ fix.checkTitle }} — {{ nameOf(fix.nodeId) }}
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
