<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Saving } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useCostStore, type CostMode } from '@/stores/cost'
import { useGraphStore } from '@/stores/graph'
import { RISK, money } from '@/lib/cost'
import { nodeColor, relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaTile from '../ui/CaTile.vue'
import DailySpendChart from '../cost/DailySpendChart.vue'
import RankBars, { type RankRow } from '../cost/RankBars.vue'
import FixCommands from '../compliance/FixCommands.vue'

/**
 * Where the money goes, and how to spend less.
 *
 * Spend is the bill, from Cost Explorer, by service and day. Run-rate is an
 * estimate from list prices, by resource and VPC. They answer different
 * questions and never share a total: each mode says which one it shows.
 */

const app = useAppStore()
const graph = useGraphStore()
const cost = useCostStore()

const MODES: Array<{ id: CostMode; label: string; hint: string }> = [
  { id: 'spend', label: 'Spend', hint: 'What AWS billed, from Cost Explorer' },
  { id: 'run-rate', label: 'Run-rate', hint: 'Estimated from list prices × what is running now' },
  { id: 'savings', label: 'Savings', hint: 'Ways to spend less, largest first' },
]

const actual = computed(() => cost.report?.actual)
const currency = computed(() => actual.value?.currency ?? 'USD')
const fmt = (value: number): string => money(value, currency.value)

function nameOf(nodeId: string): string {
  const node = graph.nodeById.get(nodeId)
  return node ? graph.displayName(node) : nodeId
}

function open(nodeId: string): void {
  graph.select(nodeId)
  app.detailTab = 'cost'
}

// --- spend ---------------------------------------------------------------

// Last month is shown as a figure, not a % change: month to date against a
// whole month reads as a fall every time until the month is nearly over.
const serviceRows = computed<RankRow[]>(() =>
  (actual.value?.byService ?? []).map((row) => ({
    key: row.key,
    label: row.key,
    amount: row.monthToDate,
    sub: row.lastMonth > 0 ? `${fmt(row.lastMonth)} last month` : 'nothing last month',
  })),
)
const regionRows = computed<RankRow[]>(() =>
  (actual.value?.byRegion ?? []).map((row) => ({ key: row.key, label: row.key, amount: row.amount })),
)

const enabling = ref(false)
async function enable(): Promise<void> {
  enabling.value = true
  try {
    await cost.setCostExplorer(true)
  } finally {
    enabling.value = false
  }
}

// --- run-rate ------------------------------------------------------------

const vpcRows = computed<RankRow[]>(() => {
  const totals = new Map<string, number>()
  for (const [nodeId, amount] of cost.byNode) {
    const vpcId = graph.nodeById.get(nodeId)?.vpcId ?? ''
    totals.set(vpcId, (totals.get(vpcId) ?? 0) + amount)
  }
  return [...totals]
    .map(([vpcId, amount]) => {
      const vpc = vpcId ? graph.nodeById.get(vpcId) : undefined
      return {
        key: vpcId || 'outside',
        label: vpcId ? `${vpc ? graph.displayName(vpc) : vpcId}${vpc?.region ? ` · ${vpc.region}` : ''}` : 'Outside any VPC',
        amount,
      }
    })
    .sort((a, b) => b.amount - a.amount)
})

const typeRows = computed<RankRow[]>(() => {
  const totals = new Map<string, number>()
  for (const [nodeId, amount] of cost.byNode) {
    const label = graph.nodeById.get(nodeId)?.typeLabel ?? 'Other'
    totals.set(label, (totals.get(label) ?? 0) + amount)
  }
  return [...totals].map(([key, amount]) => ({ key, label: key, amount })).sort((a, b) => b.amount - a.amount)
})

const resourceRows = computed(() =>
  [...cost.byNode]
    .sort((a, b) => b[1] - a[1])
    .map(([nodeId, amount]) => ({
      nodeId,
      amount,
      node: graph.nodeById.get(nodeId),
      components: (cost.report?.runRate.lines ?? []).filter((line) => line.nodeId === nodeId),
    })),
)

const showUnpriced = ref(false)

// --- savings -------------------------------------------------------------

const savingsShare = computed(() =>
  cost.runRate > 0 ? Math.round((cost.potentialSavings / cost.runRate) * 100) : null,
)

function fixScript(saving: Saving): string {
  const fix = saving.fix
  if (!fix) return ''
  const header = [`# ${saving.title} — ${nameOf(saving.nodeId)}; review before running, CloudAtlas does not run this`]
  if (fix.needsInput) header.push('# Replace every <placeholder> with your own value first.')
  return `${[...header, ...fix.commands].join('\n')}\n`
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[38px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <span class="text-[12.5px] font-semibold">Cost</span>
      <div class="flex gap-px rounded-[7px] border border-border bg-panel2 p-[2px]" role="tablist">
        <button
          v-for="option in MODES"
          :key="option.id"
          type="button"
          role="tab"
          :aria-selected="cost.mode === option.id"
          class="h-[24px] cursor-pointer rounded-[5px] px-[10px] text-[11.5px] transition-colors"
          :class="cost.mode === option.id ? 'bg-raise font-semibold text-text' : 'text-muted hover:text-text'"
          @click="cost.mode = option.id"
        >
          {{ option.label }}
          <span v-if="option.id === 'savings' && cost.report?.savings.length" class="ml-[3px] font-mono text-[10.5px] text-ok">{{
            cost.report.savings.length
          }}</span>
        </button>
      </div>
      <span class="text-[11.5px] text-faint">{{ MODES.find((m) => m.id === cost.mode)?.hint }}</span>
    </div>

    <CaEmptyState v-if="cost.error" tone="error" class="flex-1" title="Could not load costs" :description="cost.error" />
    <CaEmptyState
      v-else-if="!cost.report"
      tone="pending"
      class="flex-1"
      :title="cost.loading ? 'Looking up prices…' : 'No scan to price yet'"
    />

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-[1180px] px-6 py-5">
        <!-- ============================== Spend ============================== -->
        <template v-if="cost.mode === 'spend'">
          <div
            v-if="actual?.status === 'demo'"
            class="mb-4 rounded-[9px] border border-border bg-panel px-[12px] py-[9px] text-[11.5px] text-muted"
          >
            {{ actual.message }}
          </div>

          <section v-if="actual?.status === 'disabled'" class="ca-card mb-4">
            <h2 class="ca-card-title">Actual spend is off</h2>
            <p class="mb-3 max-w-[720px] text-[12px] leading-[1.6] text-muted">
              Actual spend comes from AWS Cost Explorer, which charges $0.01 per request. A refresh is four
              requests and is cached for 12 hours, and a manual refresh is limited to once every 10 minutes —
              at most a few cents a day. The Run-rate and Savings tabs work without it.
            </p>
            <button
              type="button"
              class="h-[32px] cursor-pointer rounded-[7px] border border-border2 bg-raise px-[14px] text-[12.5px] font-medium text-text hover:border-text disabled:opacity-50"
              :disabled="enabling"
              @click="enable"
            >
              {{ enabling ? 'Turning on…' : 'Turn on Cost Explorer (about $0.04 per refresh)' }}
            </button>
          </section>

          <CaEmptyState
            v-else-if="actual?.status === 'denied' || actual?.status === 'error'"
            tone="error"
            title="Actual spend unavailable"
            :description="actual.message ?? ''"
          />

          <template v-else-if="actual">
            <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div class="ca-stat">
                <div class="ca-stat-value">{{ money(actual.monthToDate, currency) }}</div>
                <div class="ca-stat-label">Month to date</div>
              </div>
              <div class="ca-stat">
                <div class="ca-stat-value">{{ money(actual.forecastMonthEnd, currency) }}</div>
                <div class="ca-stat-label">Forecast, month end</div>
              </div>
              <div class="ca-stat">
                <div class="ca-stat-value">{{ money(actual.lastMonth, currency) }}</div>
                <div class="ca-stat-label">Last month</div>
              </div>
              <div class="ca-stat">
                <div class="ca-stat-value text-[18px]">{{ actual.fetchedAt ? relativeTime(actual.fetchedAt) : '—' }}</div>
                <div class="ca-stat-label flex items-center gap-2">
                  Fetched
                  <button
                    v-if="actual.status === 'ok'"
                    type="button"
                    class="cursor-pointer text-[11px] text-muted underline decoration-dotted hover:text-text disabled:opacity-50"
                    :disabled="cost.refreshing"
                    title="Re-reads Cost Explorer: four requests, about $0.04. Limited to once every 10 minutes."
                    @click="cost.load(true)"
                  >
                    {{ cost.refreshing ? 'refreshing…' : 'refresh (~$0.04)' }}
                  </button>
                </div>
              </div>
            </div>

            <section class="ca-card mb-4">
              <h2 class="ca-card-title">Daily spend, last 30 days</h2>
              <DailySpendChart :days="actual.daily" :format="fmt" />
            </section>

            <div class="grid gap-4 md:grid-cols-[3fr_2fr]">
              <section class="ca-card">
                <h2 class="ca-card-title">By service, month to date</h2>
                <RankBars :rows="serviceRows" :format="fmt" :limit="10" />
              </section>
              <section class="ca-card">
                <h2 class="ca-card-title">By region, month to date</h2>
                <RankBars :rows="regionRows" :format="fmt" />
              </section>
            </div>
          </template>
        </template>

        <!-- ============================ Run-rate ============================ -->
        <template v-else-if="cost.mode === 'run-rate'">
          <div class="mb-4 rounded-[9px] border border-border bg-panel px-[12px] py-[9px] text-[11.5px] leading-[1.55] text-muted">
            <span class="font-semibold text-text">An estimate, not the bill.</span>
            On-demand list price × what is running now. It leaves out data transfer, requests and other usage,
            and any discounts — the Spend tab has the billed figure.
            <span class="text-faint">Source: {{ cost.report.runRate.source }}.</span>
          </div>
          <CaEmptyState
            v-if="cost.report.runRate.message"
            tone="error"
            title="Prices unavailable"
            :description="cost.report.runRate.message"
          />

          <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            <div class="ca-stat">
              <div class="ca-stat-value">{{ money(cost.runRate) }}</div>
              <div class="ca-stat-label">Estimated per month</div>
            </div>
            <div class="ca-stat">
              <div class="ca-stat-value">{{ cost.byNode.size }}</div>
              <div class="ca-stat-label">Resources priced</div>
            </div>
            <div class="ca-stat">
              <div class="ca-stat-value">{{ cost.report.runRate.unpriced.length }}</div>
              <div class="ca-stat-label">Usage-based or not estimated</div>
            </div>
          </div>

          <div class="mb-4 grid gap-4 md:grid-cols-2">
            <section class="ca-card">
              <h2 class="ca-card-title">By VPC</h2>
              <RankBars :rows="vpcRows" :format="money" />
            </section>
            <section class="ca-card">
              <h2 class="ca-card-title">By resource type</h2>
              <RankBars :rows="typeRows" :format="money" />
            </section>
          </div>

          <section class="ca-card mb-4">
            <h2 class="ca-card-title">By resource</h2>
            <ul class="flex flex-col">
              <li v-for="row in resourceRows" :key="row.nodeId" class="border-t border-border first:border-t-0">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-start gap-[10px] py-[8px] text-left hover:bg-raise/40"
                  @click="open(row.nodeId)"
                >
                  <CaTile
                    v-if="row.node"
                    :abbr="row.node.abbr"
                    :color="nodeColor(row.node)"
                    :node-type="row.node.type"
                    :size="22"
                    :radius="5"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[12.5px] font-medium">{{ nameOf(row.nodeId) }}</span>
                    <span class="block truncate font-mono text-[10.5px] text-faint">
                      {{ row.components.map((line) => `${line.component} ${money(line.monthlyUsd)}`).join(' · ') }}
                    </span>
                  </span>
                  <span class="shrink-0 font-mono text-[12.5px]">{{ money(row.amount) }}<span class="text-faint">/mo</span></span>
                  <span
                    v-if="cost.savingsByNode.get(row.nodeId)"
                    class="shrink-0 rounded-full border border-border2 px-[7px] text-[10.5px] text-ok"
                    title="Has savings suggestions"
                  >
                    save
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section class="ca-card">
            <button type="button" class="flex w-full cursor-pointer items-center gap-2 text-left" @click="showUnpriced = !showUnpriced">
              <h2 class="ca-card-title !mb-0">Not estimated ({{ cost.report.runRate.unpriced.length }})</h2>
              <span class="ml-auto text-[10px] text-faint">{{ showUnpriced ? '▾' : '▸' }}</span>
            </button>
            <p class="mt-[6px] text-[11.5px] text-faint">
              Billed by usage — requests, GB, invocations — which a snapshot of the configuration cannot price.
              Their cost is in the Spend tab.
            </p>
            <ul v-if="showUnpriced" class="mt-[8px] flex flex-col gap-[4px]">
              <li v-for="entry in cost.report.runRate.unpriced" :key="entry.nodeId" class="flex gap-2 text-[11.5px]">
                <span class="w-[220px] shrink-0 truncate text-text">{{ nameOf(entry.nodeId) }}</span>
                <span class="text-muted">{{ entry.reason }}</span>
              </li>
            </ul>
          </section>
        </template>

        <!-- ============================= Savings ============================= -->
        <template v-else>
          <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            <div class="ca-stat">
              <div class="ca-stat-value text-ok">{{ money(cost.potentialSavings) }}</div>
              <div class="ca-stat-label">Estimated savings per month</div>
            </div>
            <div class="ca-stat">
              <div class="ca-stat-value">{{ savingsShare === null ? '—' : `${savingsShare}%` }}</div>
              <div class="ca-stat-label">Of the estimated run-rate</div>
            </div>
            <div class="ca-stat">
              <div class="ca-stat-value">{{ cost.report.savings.length }}</div>
              <div class="ca-stat-label">Suggestions</div>
            </div>
          </div>
          <p class="mb-4 text-[11.5px] leading-[1.55] text-faint">
            Estimated from list prices. Where a resource has more than one suggestion, the total counts only the
            largest, so it never promises money twice. CloudAtlas never runs the commands: review them, then run
            them yourself.
          </p>

          <CaEmptyState
            v-if="cost.report.savings.length === 0"
            glyph="✓"
            title="No savings found"
            description="Nothing in the scan matched a savings check. Usage patterns (idle instances, oversized databases) need metrics and are not assessed yet."
          />

          <ol class="flex flex-col gap-[10px]">
            <li
              v-for="(saving, index) in cost.report.savings"
              :key="saving.id"
              class="rounded-[10px] border border-border bg-panel p-[14px]"
            >
              <div class="flex items-start gap-[11px]">
                <span class="mt-[1px] font-mono text-[12px] font-semibold text-faint">{{ index + 1 }}</span>
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
                    @click="open(saving.nodeId)"
                  >
                    <CaTile
                      v-if="graph.nodeById.get(saving.nodeId)"
                      :abbr="graph.nodeById.get(saving.nodeId)!.abbr"
                      :color="nodeColor(graph.nodeById.get(saving.nodeId)!)"
                      :node-type="graph.nodeById.get(saving.nodeId)!.type"
                      :size="18"
                      :radius="4"
                    />
                    <span class="text-[12px] text-text">{{ nameOf(saving.nodeId) }}</span>
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
                    :script="fixScript(saving)"
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
          </ol>
        </template>
      </div>
    </div>
  </div>
</template>
