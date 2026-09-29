<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORY_LABELS, type GraphNode } from '@cloudatlas/shared'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import { useAppStore } from '@/stores/app'
import {
  blindSpots,
  coverage,
  findingsByKind,
  healthBreakdown,
  percent,
  rank,
  realResources,
  type Ranked,
} from '@/lib/analytics'
import CaEmptyState from '../ui/CaEmptyState.vue'

/**
 * Account-wide analytics.
 *
 * Every panel is a ranking of one measure, so every bar is one hue. Colouring
 * bars by category would spend the only free channel restating the length, and
 * the service-category palette is not separable enough for colour to carry
 * identity on its own — on the diagram each node also has an icon and a label,
 * which a bar does not.
 *
 * The exception is health, where colour genuinely means state. There it is
 * paired with a glyph, a label and a count, so it never depends on colour.
 */

const graph = useGraphStore()
const health = useHealthStore()
const app = useAppStore()

const nodes = computed(() => graph.graph?.nodes ?? [])
const resources = computed(() => realResources(nodes.value))

const coverageRows = computed(() => coverage(nodes.value))
const byType = computed(() =>
  rank(resources.value, (node) => node.type, (key) => key.replace(/-/g, ' ')),
)
const byCategory = computed(() =>
  rank(resources.value, (node) => node.category, (key) => CATEGORY_LABELS[key as never] ?? key),
)
const byRegion = computed(() => rank(resources.value, (node) => node.region))
const states = computed(() => healthBreakdown(nodes.value))
const findingKinds = computed(() => findingsByKind(health.findings))
const gaps = computed(() => blindSpots(nodes.value))

const totalHealth = computed(() => states.value.reduce((sum, row) => sum + row.count, 0))

/** Longest bar sets the scale, so every panel reads against its own maximum. */
function scale(rows: Ranked[]): number {
  return Math.max(1, ...rows.map((row) => row.count))
}

const STATE_COLOR: Record<string, string> = {
  critical: 'var(--ca-bad)',
  warn: 'var(--ca-warn)',
  ok: 'var(--ca-ok)',
  unknown: 'var(--ca-faint)',
}

function openResource(node: GraphNode): void {
  graph.select(node.id)
  app.setView('resource')
}

const lastSync = computed(() => {
  const at = graph.graph?.scannedAt
  if (!at) return '—'
  const minutes = Math.round((Date.now() - at) / 60_000)
  return minutes < 1 ? 'just now' : `${minutes}m ago`
})
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <CaEmptyState
      v-if="!graph.graph"
      title="Nothing to analyse yet"
      description="Run a scan first. Analytics are computed from the scanned estate, not fetched separately."
    />

    <div v-else class="mx-auto w-full max-w-[1180px] px-6 py-5">
      <!-- Headline numbers. The number is the chart. -->
      <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="ca-stat">
          <div class="ca-stat-value">{{ resources.length }}</div>
          <div class="ca-stat-label">Resources</div>
        </div>
        <div class="ca-stat">
          <div class="ca-stat-value">{{ byRegion.length }}</div>
          <div class="ca-stat-label">Regions</div>
        </div>
        <div class="ca-stat">
          <div class="ca-stat-value">{{ graph.vpcs.length }}</div>
          <div class="ca-stat-label">VPCs</div>
        </div>
        <div class="ca-stat">
          <div class="ca-stat-value">{{ lastSync }}</div>
          <div class="ca-stat-label">Last sync</div>
        </div>
      </div>

      <!-- Coverage: the honest answer to "analytics for all resources" -->
      <section class="ca-card mb-4">
        <h2 class="ca-card-title">Observability coverage</h2>
        <p class="mb-3 text-[11.5px] leading-[1.55] text-muted">
          What CloudAtlas can actually see, against every resource it found. The uncovered
          share is stated rather than excluded — a percentage computed only over what a tool
          knows how to measure always looks good.
        </p>

        <div v-for="row in coverageRows" :key="row.kind" class="mb-[13px] last:mb-0">
          <div class="mb-[5px] flex items-baseline gap-2">
            <span class="text-[12px] text-text">{{ row.label }}</span>
            <span class="ml-auto font-mono text-[11.5px] text-muted">
              {{ row.covered }} of {{ row.total }}
            </span>
            <span class="w-[38px] text-right font-mono text-[11.5px] text-text">
              {{ percent(row.covered, row.total) }}%
            </span>
          </div>
          <!-- Part-of-whole, one measure: covered against the remainder, with a
               2px surface gap rather than a border between them. -->
          <div class="flex h-[8px] w-full gap-[2px] overflow-hidden rounded-[4px] bg-border">
            <div
              class="h-full rounded-[4px] bg-[var(--ca-network)]"
              :style="{ width: `${percent(row.covered, row.total)}%` }"
              :title="`${row.covered} covered`"
            />
            <div
              v-if="row.covered < row.total"
              class="h-full flex-1 rounded-[4px] bg-border2"
              :title="`${row.total - row.covered} not covered — ${row.gapReason}`"
            />
          </div>
          <p v-if="row.covered < row.total" class="mt-[4px] text-[11px] text-faint">
            {{ row.total - row.covered }} uncovered — {{ row.gapReason }}.
          </p>
        </div>
      </section>

      <!-- Health. Colour means state here, so it carries a glyph and a label too. -->
      <section class="ca-card mb-4">
        <h2 class="ca-card-title">Health</h2>
        <div class="mb-[10px] flex h-[10px] w-full gap-[2px] overflow-hidden rounded-[5px]">
          <div
            v-for="row in states.filter((entry) => entry.count > 0)"
            :key="row.state"
            class="h-full rounded-[5px]"
            :style="{
              width: `${percent(row.count, totalHealth)}%`,
              background: STATE_COLOR[row.state],
            }"
            :title="`${row.label}: ${row.count}`"
          />
        </div>
        <div class="flex flex-wrap gap-x-5 gap-y-[6px]">
          <div v-for="row in states" :key="row.state" class="flex items-center gap-[6px]">
            <span
              class="text-[10px] leading-none"
              :style="{ color: STATE_COLOR[row.state] }"
              aria-hidden="true"
              >{{ row.glyph }}</span
            >
            <span class="text-[11.5px] text-muted">{{ row.label }}</span>
            <span class="font-mono text-[11.5px] text-text">{{ row.count }}</span>
          </div>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section class="ca-card">
          <h2 class="ca-card-title">Resources by type</h2>
          <div v-for="row in byType" :key="row.key" class="ca-bar-row">
            <span class="ca-bar-label" :title="row.label">{{ row.label }}</span>
            <span class="ca-bar-track">
              <span
                class="ca-bar-fill"
                :style="{ width: `${(row.count / scale(byType)) * 100}%` }"
                :title="`${row.label}: ${row.count}`"
              />
            </span>
            <span class="ca-bar-value">{{ row.count }}</span>
          </div>
        </section>

        <section class="ca-card">
          <h2 class="ca-card-title">Resources by category</h2>
          <div v-for="row in byCategory" :key="row.key" class="ca-bar-row">
            <span class="ca-bar-label" :title="row.label">{{ row.label }}</span>
            <span class="ca-bar-track">
              <span
                class="ca-bar-fill"
                :style="{ width: `${(row.count / scale(byCategory)) * 100}%` }"
                :title="`${row.label}: ${row.count}`"
              />
            </span>
            <span class="ca-bar-value">{{ row.count }}</span>
          </div>
        </section>

        <section class="ca-card">
          <h2 class="ca-card-title">Resources by region</h2>
          <div v-for="row in byRegion" :key="row.key" class="ca-bar-row">
            <span class="ca-bar-label" :title="row.label">{{ row.label }}</span>
            <span class="ca-bar-track">
              <span
                class="ca-bar-fill"
                :style="{ width: `${(row.count / scale(byRegion)) * 100}%` }"
                :title="`${row.label}: ${row.count}`"
              />
            </span>
            <span class="ca-bar-value">{{ row.count }}</span>
          </div>
        </section>

        <section class="ca-card">
          <h2 class="ca-card-title">Findings by kind</h2>
          <p v-if="findingKinds.length === 0" class="text-[11.5px] text-faint">
            No open findings.
          </p>
          <div v-for="row in findingKinds" :key="row.key" class="ca-bar-row">
            <span class="ca-bar-label" :title="row.label">{{ row.label }}</span>
            <span class="ca-bar-track">
              <span
                class="ca-bar-fill"
                :style="{ width: `${(row.count / scale(findingKinds)) * 100}%` }"
                :title="`${row.label}: ${row.count}`"
              />
            </span>
            <span class="ca-bar-value">{{ row.count }}</span>
          </div>
        </section>
      </div>

      <!-- The gap list, named rather than summarised away -->
      <section class="ca-card mt-4">
        <h2 class="ca-card-title">Blind spots</h2>
        <p class="mb-3 text-[11.5px] leading-[1.55] text-muted">
          Resources with neither CloudWatch metrics nor a discovered log group. Nothing here
          is necessarily wrong — many of these have nothing to publish — but they are the
          resources this tool cannot tell you anything about.
        </p>
        <p v-if="gaps.length === 0" class="text-[11.5px] text-faint">
          Every resource has metrics, logs, or both.
        </p>
        <div v-else class="max-h-[320px] overflow-y-auto">
          <button
            v-for="node in gaps"
            :key="node.id"
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 rounded-[6px] px-[7px] py-[5px] text-left hover:bg-raise"
            @click="openResource(node)"
          >
            <span class="min-w-0 flex-1 truncate text-[12px] text-text">{{
              graph.displayName(node)
            }}</span>
            <span class="shrink-0 font-mono text-[11px] text-faint">{{ node.typeLabel }}</span>
            <span class="w-[86px] shrink-0 text-right font-mono text-[11px] text-faint">{{
              node.region
            }}</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ca-card {
  border-radius: 10px;
  border: 1px solid var(--ca-border);
  background: var(--ca-panel);
  padding: 13px 14px 14px;
  min-width: 0;
}

.ca-card-title {
  margin-bottom: 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ca-faint);
}

.ca-stat {
  border-radius: 10px;
  border: 1px solid var(--ca-border);
  background: var(--ca-panel);
  padding: 11px 13px 12px;
}

.ca-stat-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ca-text);
}

.ca-stat-label {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--ca-muted);
}

.ca-bar-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 3px 0;
}

.ca-bar-label {
  width: 116px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--ca-muted);
}

.ca-bar-track {
  position: relative;
  flex: 1;
  height: 8px;
  min-width: 0;
  border-radius: 4px;
  background: var(--ca-border);
}

/* One hue for every bar: the length is the measure, so colour is free and
   should stay free rather than double-encoding it. */
.ca-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  background: var(--ca-network);
}

.ca-bar-value {
  width: 34px;
  flex-shrink: 0;
  text-align: right;
  font-family: var(--ca-mono, ui-monospace, monospace);
  font-size: 11.5px;
  color: var(--ca-text);
}
</style>
