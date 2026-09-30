<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { METRIC_CATALOG } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import { copyText, nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'
import CaStatePill from '../ui/CaStatePill.vue'
import CaEmptyState from '../ui/CaEmptyState.vue'
import OverviewTab from '../detail/OverviewTab.vue'
import MetricsTab from '../detail/MetricsTab.vue'
import LogsTab from '../detail/LogsTab.vue'
import WafTab from '../detail/WafTab.vue'
import DbLoadTab from '../detail/DbLoadTab.vue'
import ConnectionsTab from '../detail/ConnectionsTab.vue'
import SecurityTab from '../detail/SecurityTab.vue'
import TagsTab from '../detail/TagsTab.vue'
import JsonTab from '../detail/JsonTab.vue'
import CostTab from '../detail/CostTab.vue'
import ComplianceTab from '../detail/ComplianceTab.vue'

/**
 * One resource, on a page of its own.
 *
 * The side panel is built for glancing at something while the diagram is still
 * in view; this is for reading. Everything the panel hides behind tabs is laid
 * out at once, because when you have decided to study a resource, clicking
 * through seven tabs to assemble the picture is the wrong shape of work.
 *
 * The sections are the same components the panel uses, not copies. A breakdown
 * that drifted from the panel would be worse than not having one.
 */

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const node = computed(() => graph.selectedNode)
const copied = ref(false)

const findings = computed(() =>
  node.value ? (health.findingsByNode.get(node.value.id) ?? []) : [],
)

const hasMetrics = computed(() => (node.value ? METRIC_CATALOG[node.value.type] !== undefined : false))
const isWebAcl = computed(() => node.value?.type === 'waf-web-acl')
const isDatabase = computed(() => node.value?.type === 'rds')

async function copyArn(): Promise<void> {
  if (!node.value?.arn) return
  if (await copyText(node.value.arn)) {
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  }
}

function back(): void {
  app.setView(app.previousView)
}

/** Escape returns to the diagram, which is what a full-page view should do. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  const target = event.target as HTMLElement | null
  // Not while the reader is in a field — Escape there means "clear this".
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  back()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <CaEmptyState
      v-if="!node"
      title="No resource selected"
      description="Pick a resource on the diagram, then open View details."
    />

    <div v-else class="mx-auto w-full max-w-[1180px] px-6 py-5">
      <!-- Header -->
      <div class="mb-5 flex items-start gap-[13px]">
        <button
          type="button"
          class="mt-[5px] h-[28px] shrink-0 cursor-pointer rounded-[7px] border border-border bg-panel px-[10px] text-[12px] text-muted transition-colors hover:text-text"
          @click="back()"
        >
          ← Back
        </button>

        <CaTile
          :abbr="node.abbr"
          :color="nodeColor(node)"
          :node-type="node.type"
          :size="42"
          :radius="9"
        />

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="min-w-0 break-all text-[19px] font-semibold leading-tight">
              {{ node.name }}
            </h1>
            <CaStatePill :state="node.state" big />
          </div>
          <div class="mt-[3px] text-[12.5px] text-muted">
            {{ node.typeLabel }} · {{ node.az ?? node.region }}
            <template v-if="node.vpcId"> · {{ node.vpcId }}</template>
          </div>

          <div v-if="node.arn" class="mt-[9px] flex items-center gap-2">
            <span class="min-w-0 break-all font-mono text-[10.5px] text-faint">{{ node.arn }}</span>
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-[5px] border border-border2 bg-transparent px-[7px] py-[2px] text-[10.5px] text-muted hover:text-text"
              @click="copyArn()"
            >
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>

        <a
          v-if="node.consoleUrl"
          :href="node.consoleUrl"
          target="_blank"
          rel="noreferrer"
          class="mt-[5px] shrink-0 rounded-[7px] border border-border2 bg-raise px-[11px] py-[6px] text-[12px] text-text hover:border-text"
        >
          Open in AWS Console ↗
        </a>
      </div>

      <!-- Findings lead, because they are the reason to open this page -->
      <section v-if="findings.length > 0" class="mb-4 flex flex-col gap-2">
        <div
          v-for="finding in findings"
          :key="finding.id"
          class="rounded-[9px] border px-[13px] py-[11px]"
          :class="
            finding.severity === 'critical'
              ? 'border-bad/45 bg-bad/10'
              : 'border-warn/45 bg-warn/10'
          "
        >
          <div
            class="text-[13px] font-semibold"
            :class="finding.severity === 'critical' ? 'text-bad' : 'text-warn'"
          >
            {{ finding.title }}
          </div>
          <p class="mt-[5px] text-[12px] leading-[1.6] text-muted">{{ finding.detail }}</p>
          <ul v-if="finding.evidence.length > 0" class="mt-[7px] flex flex-col gap-[3px]">
            <li
              v-for="line in finding.evidence"
              :key="line"
              class="font-mono text-[11px] text-faint"
            >
              {{ line }}
            </li>
          </ul>
        </div>
      </section>

      <!-- Two columns on wide screens; stacked when there is not room -->
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Overview</h2>
          <OverviewTab :node="node" hide-findings />
        </section>

        <section v-if="hasMetrics" class="ca-detail-card">
          <h2 class="ca-detail-heading">Metrics</h2>
          <MetricsTab :key="node.id" :node="node" />
        </section>

        <section v-if="isDatabase" class="ca-detail-card">
          <h2 class="ca-detail-heading">Database load</h2>
          <DbLoadTab :key="node.id" :node="node" />
        </section>

        <section v-if="isWebAcl" class="ca-detail-card">
          <h2 class="ca-detail-heading">Sampled requests</h2>
          <WafTab :key="node.id" :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Connections</h2>
          <ConnectionsTab :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Security</h2>
          <SecurityTab :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Cost</h2>
          <CostTab :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Compliance</h2>
          <ComplianceTab :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Logs</h2>
          <LogsTab :node="node" />
        </section>

        <section class="ca-detail-card">
          <h2 class="ca-detail-heading">Tags</h2>
          <TagsTab :node="node" />
        </section>

        <section class="ca-detail-card xl:col-span-2">
          <h2 class="ca-detail-heading">Raw configuration</h2>
          <JsonTab :node="node" />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ca-detail-card {
  border-radius: 10px;
  border: 1px solid var(--ca-border);
  background: var(--ca-panel);
  padding: 13px 14px 14px;
  min-width: 0;
}

.ca-detail-heading {
  margin-bottom: 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ca-faint);
}
</style>
