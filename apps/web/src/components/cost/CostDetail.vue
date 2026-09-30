<script setup lang="ts">
import { computed } from 'vue'
import { costServiceOf, nodeTypesForService, type GraphNode } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useCostStore } from '@/stores/cost'
import { useGraphStore } from '@/stores/graph'
import { money } from '@/lib/cost'
import { tipsFor } from '@/lib/cost-tips'
import { nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'
import DailySpendChart from './DailySpendChart.vue'
import RankBars, { type RankRow } from './RankBars.vue'
import SavingCard from './SavingCard.vue'

/**
 * A drill-down: one service, region, VPC or resource type.
 *
 * Everything on it is scoped to that one thing — the billed figures where
 * Cost Explorer has them, the estimate for the resources the scan can see,
 * the savings found among those resources, and general ways to save on the
 * service. The last is labelled apart from the rest: it is advice, not a
 * finding.
 */

const app = useAppStore()
const graph = useGraphStore()
const cost = useCostStore()

const detail = computed(() => cost.detail!)
const report = computed(() => cost.report!)
const actual = computed(() => report.value.actual)
const hasSpend = computed(() => actual.value.status === 'ok' || actual.value.status === 'demo')

const TITLES = { service: 'Service', region: 'Region', vpc: 'VPC', type: 'Resource type' } as const

const title = computed(() => {
  if (detail.value.kind === 'vpc') {
    if (detail.value.key === 'outside') return 'Outside any VPC'
    const vpc = graph.nodeById.get(detail.value.key)
    return vpc ? graph.displayName(vpc) : detail.value.key
  }
  return detail.value.key
})

/** Resources this page is about. */
const inScope = computed<GraphNode[]>(() => {
  const { kind, key } = detail.value
  const types = kind === 'service' ? new Set(nodeTypesForService(key)) : null
  return graph.allNodes.filter((node) => {
    if (kind === 'service') return types!.has(node.type)
    if (kind === 'region') return node.region === key
    if (kind === 'vpc') return key === 'outside' ? !node.vpcId : node.vpcId === key
    return node.typeLabel === key
  })
})
const scopeIds = computed(() => new Set(inScope.value.map((node) => node.id)))

/** Estimated monthly cost per resource — for a service, only its lines billed under that service. */
const estimates = computed(() => {
  const totals = new Map<string, number>()
  for (const line of report.value.runRate.lines) {
    if (!scopeIds.value.has(line.nodeId)) continue
    const node = graph.nodeById.get(line.nodeId)
    if (detail.value.kind === 'service' && costServiceOf(node?.type ?? '', line.component) !== detail.value.key) continue
    totals.set(line.nodeId, (totals.get(line.nodeId) ?? 0) + line.monthlyUsd)
  }
  return totals
})
const estimateTotal = computed(() => [...estimates.value.values()].reduce((sum, value) => sum + value, 0))

const resources = computed(() =>
  [...estimates.value]
    .sort((a, b) => b[1] - a[1])
    .map(([nodeId, amount]) => ({
      nodeId,
      amount,
      node: graph.nodeById.get(nodeId),
      lines: report.value.runRate.lines.filter((line) => line.nodeId === nodeId),
    })),
)
const notEstimated = computed(() => report.value.runRate.unpriced.filter((entry) => scopeIds.value.has(entry.nodeId)))
const savings = computed(() => report.value.savings.filter((saving) => scopeIds.value.has(saving.nodeId)))
const savingsTotal = computed(() => {
  const best = new Map<string, number>()
  for (const saving of savings.value) {
    if (saving.monthlySavingsUsd !== null) best.set(saving.nodeId, Math.max(best.get(saving.nodeId) ?? 0, saving.monthlySavingsUsd))
  }
  return [...best.values()].reduce((sum, value) => sum + value, 0)
})

// --- billed figures, where Cost Explorer has them -------------------------

const billedService = computed(() =>
  detail.value.kind === 'service' ? actual.value.byService.find((row) => row.key === detail.value.key) : undefined,
)
const billedRegion = computed(() =>
  detail.value.kind === 'region' ? actual.value.byRegion.find((row) => row.key === detail.value.key) : undefined,
)
const shareOfBill = computed(() => {
  const mtd = actual.value.monthToDate
  return billedService.value && mtd ? Math.round((billedService.value.monthToDate / mtd) * 100) : null
})
const serviceDaily = computed(() => {
  const series = actual.value.dailyByService?.find((entry) => entry.key === detail.value.key)
  return series ? actual.value.daily.map((day, index) => ({ key: day.key, amount: series.amounts[index] ?? 0 })) : null
})

// --- breakdowns that lead further in --------------------------------------

const typeRows = computed<RankRow[]>(() => {
  const totals = new Map<string, number>()
  for (const [nodeId, amount] of estimates.value) {
    const label = graph.nodeById.get(nodeId)?.typeLabel ?? 'Other'
    totals.set(label, (totals.get(label) ?? 0) + amount)
  }
  return [...totals]
    .map(([key, amount]) => ({ key, label: key, amount, onClick: () => cost.openDetail('type', key) }))
    .sort((a, b) => b.amount - a.amount)
})

const serviceRows = computed<RankRow[]>(() => {
  const totals = new Map<string, number>()
  for (const line of report.value.runRate.lines) {
    if (!scopeIds.value.has(line.nodeId)) continue
    const service = costServiceOf(graph.nodeById.get(line.nodeId)?.type ?? '', line.component)
    if (service) totals.set(service, (totals.get(service) ?? 0) + line.monthlyUsd)
  }
  return [...totals]
    .map(([key, amount]) => ({ key, label: key, amount, onClick: () => cost.openDetail('service', key) }))
    .sort((a, b) => b.amount - a.amount)
})

/** Advice for the service behind this page, when there is one. */
const tipsService = computed(() => {
  if (detail.value.kind === 'service') return detail.value.key
  if (detail.value.kind === 'type') {
    const node = inScope.value[0]
    return node ? costServiceOf(node.type, node.type === 'ec2' ? 'Instance' : '') : null
  }
  return null
})
const tips = computed(() => tipsFor(tipsService.value))

function openResource(nodeId: string): void {
  graph.select(nodeId)
  app.detailTab = 'cost'
  app.openResource()
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center gap-2 text-[12px]">
      <button type="button" class="cursor-pointer text-muted hover:text-text" @click="cost.closeDetail()">‹ Cost</button>
      <span class="text-faint">/</span>
      <span class="text-faint">{{ TITLES[detail.kind] }}</span>
    </div>
    <h1 class="mb-1 text-[20px] font-semibold">{{ title }}</h1>
    <p class="mb-4 text-[12px] text-muted">
      {{ inScope.length }} resource{{ inScope.length === 1 ? '' : 's' }} in the scan
      <template v-if="detail.kind === 'service'"> bill under this service</template>
      <template v-else-if="detail.kind === 'region'"> in this region</template>
      <template v-else-if="detail.kind === 'vpc'"> in this network</template>
      <template v-else> of this type</template>.
    </p>

    <!-- Tiles: the bill where Cost Explorer has it, the estimate for what the scan sees. -->
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      <template v-if="detail.kind === 'service' && hasSpend">
        <div class="ca-stat">
          <div class="ca-stat-value">{{ money(billedService?.monthToDate ?? 0, actual.currency) }}</div>
          <div class="ca-stat-label">Billed, month to date</div>
        </div>
        <div class="ca-stat">
          <div class="ca-stat-value">{{ money(billedService?.lastMonth ?? 0, actual.currency) }}</div>
          <div class="ca-stat-label">Billed last month</div>
        </div>
        <div class="ca-stat">
          <div class="ca-stat-value">{{ shareOfBill === null ? '—' : `${shareOfBill}%` }}</div>
          <div class="ca-stat-label">Of this month's bill</div>
        </div>
      </template>
      <div v-else-if="detail.kind === 'region' && hasSpend" class="ca-stat">
        <div class="ca-stat-value">{{ money(billedRegion?.amount ?? 0, actual.currency) }}</div>
        <div class="ca-stat-label">Billed, month to date</div>
      </div>
      <div class="ca-stat">
        <div class="ca-stat-value">{{ money(estimateTotal) }}</div>
        <div class="ca-stat-label">Estimated per month ({{ estimates.size }} priced)</div>
      </div>
      <div v-if="detail.kind !== 'service'" class="ca-stat">
        <div class="ca-stat-value text-ok">{{ money(savingsTotal) }}</div>
        <div class="ca-stat-label">Savings found per month</div>
      </div>
      <div v-if="detail.kind === 'vpc' || detail.kind === 'type'" class="ca-stat">
        <div class="ca-stat-value">{{ savings.length }}</div>
        <div class="ca-stat-label">Suggestions</div>
      </div>
    </div>

    <p
      v-if="detail.kind === 'service' && hasSpend && billedService"
      class="mb-4 max-w-[860px] text-[11.5px] leading-[1.55] text-faint"
    >
      The bill and the estimate differ on purpose: the bill includes usage — data transfer, requests,
      I/O — and any discounts, while the estimate is list price for what is configured now. A bill far
      above the estimate points at usage charges; far below, at discounts or savings plans.
    </p>

    <section v-if="detail.kind === 'service' && serviceDaily" class="ca-card mb-4">
      <h2 class="ca-card-title">Daily, last 30 days</h2>
      <DailySpendChart :days="serviceDaily" :format="(value: number) => money(value, actual.currency)" />
    </section>

    <div v-if="detail.kind === 'region' || detail.kind === 'vpc'" class="mb-4 grid gap-4 md:grid-cols-2">
      <section class="ca-card">
        <h2 class="ca-card-title">Estimated, by service</h2>
        <RankBars :rows="serviceRows" :format="money" />
      </section>
      <section class="ca-card">
        <h2 class="ca-card-title">Estimated, by resource type</h2>
        <RankBars :rows="typeRows" :format="money" />
      </section>
    </div>

    <section v-if="savings.length" class="mb-4">
      <h2 class="ca-eyebrow mb-2">Found in your scan · {{ money(savingsTotal) }}/mo</h2>
      <ol class="flex flex-col gap-[10px]">
        <SavingCard v-for="saving in savings" :key="saving.id" :saving="saving" @open="openResource" />
      </ol>
    </section>

    <section class="ca-card mb-4">
      <h2 class="ca-card-title">Resources, by estimated cost</h2>
      <p v-if="resources.length === 0" class="text-[12px] text-muted">
        Nothing here has an estimate. {{ notEstimated.length ? 'See below for why.' : '' }}
      </p>
      <ul class="flex flex-col">
        <li v-for="row in resources" :key="row.nodeId" class="border-t border-border first:border-t-0">
          <button
            type="button"
            class="flex w-full cursor-pointer items-start gap-[10px] py-[8px] text-left hover:bg-raise/40"
            title="Open the resource's full page"
            @click="openResource(row.nodeId)"
          >
            <CaTile v-if="row.node" :abbr="row.node.abbr" :color="nodeColor(row.node)" :node-type="row.node.type" :size="22" :radius="5" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] font-medium">{{ row.node ? graph.displayName(row.node) : row.nodeId }}</span>
              <span class="block truncate font-mono text-[10.5px] text-faint">
                {{ row.lines.map((line) => `${line.component} ${money(line.monthlyUsd)}`).join(' · ') }}
              </span>
            </span>
            <span class="shrink-0 font-mono text-[12.5px]">{{ money(row.amount) }}<span class="text-faint">/mo</span></span>
            <span
              v-if="cost.savingsByNode.get(row.nodeId)"
              class="shrink-0 rounded-full border border-border2 px-[7px] text-[10.5px] text-ok"
            >
              save
            </span>
            <span class="shrink-0 text-[10px] text-faint">▸</span>
          </button>
        </li>
      </ul>
      <div v-if="notEstimated.length" class="mt-[10px] border-t border-border pt-[10px]">
        <div class="mb-[5px] text-[11px] font-semibold text-muted">Not estimated</div>
        <ul class="flex flex-col gap-[3px]">
          <li v-for="entry in notEstimated" :key="entry.nodeId" class="flex gap-2 text-[11.5px]">
            <button type="button" class="w-[220px] shrink-0 cursor-pointer truncate text-left text-text hover:underline" @click="openResource(entry.nodeId)">
              {{ graph.nodeById.get(entry.nodeId)?.name ?? entry.nodeId }}
            </button>
            <span class="text-muted">{{ entry.reason }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="tips.length" class="ca-card">
      <h2 class="ca-card-title">General ways to save on {{ tipsService }}</h2>
      <p class="mb-3 text-[11.5px] text-faint">Standard AWS practice, not findings from your scan.</p>
      <ul class="grid gap-3 md:grid-cols-2">
        <li v-for="tip in tips" :key="tip.title" class="rounded-[8px] border border-border bg-panel2 px-[11px] py-[9px]">
          <div class="text-[12.5px] font-medium">{{ tip.title }}</div>
          <p class="mt-[3px] text-[11.5px] leading-[1.55] text-muted">{{ tip.detail }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>
