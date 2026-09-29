<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ComplianceResult, ControlSummary, FrameworkScore } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useComplianceStore } from '@/stores/compliance'
import { useGraphStore } from '@/stores/graph'
import { CONTROL_STATUS, SEVERITY_COLOR, downloadText, fixScript, gapsCsv } from '@/lib/compliance'
import { nodeColor, relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaTile from '../ui/CaTile.vue'
import CaCheckbox from '../ui/CaCheckbox.vue'
import CaPopover from '../ui/CaPopover.vue'
import ComplianceRecommendations from '../compliance/ComplianceRecommendations.vue'
import ComplianceResources from '../compliance/ComplianceResources.vue'
import FixCommands from '../compliance/FixCommands.vue'

/**
 * Every VPC measured against a framework, with the gaps first.
 *
 * The score is deliberately narrow: met controls as a share of the controls
 * this scan could decide. Controls only a human can evidence are counted
 * beside it, never inside it, so a clean result reads as "the configuration
 * we can see is sound" and not as "compliant".
 */

const app = useAppStore()
const graph = useGraphStore()
const compliance = useComplianceStore()
const pickerOpen = ref(false)

const MODES = [
  { id: 'controls', label: 'Controls', hint: 'Framework controls, gaps first' },
  { id: 'resources', label: 'Resources', hint: 'Every resource scored on the checks your frameworks require' },
  { id: 'recommendations', label: 'Recommendations', hint: 'Fixes ranked by severity and reach' },
] as const

const frameworkMeta = computed(() =>
  compliance.frameworks.find((framework) => framework.id === compliance.framework),
)

const scopeCards = computed(() => [
  {
    id: null as string | null,
    name: 'Whole account',
    detail: `${compliance.scopes.length} scope${compliance.scopes.length === 1 ? '' : 's'}`,
    count: new Set(compliance.report?.results.map((r) => r.nodeId)).size,
    connected: 0,
    score: compliance.scoreFor(null),
  },
  ...compliance.scopes.map((scope) => ({
    id: scope.id as string | null,
    name: scope.name,
    detail: scope.kind === 'vpc' ? [scope.region, scope.cidr].filter(Boolean).join(' · ') : 'S3, CloudFront, queues, global',
    count: scope.nodeIds.length,
    connected: scope.connectedNodeIds.length,
    score: compliance.scoreFor(scope.id),
  })),
])

const activeScope = computed(() => compliance.scopes.find((scope) => scope.id === compliance.scopeId))

/** Gaps and unknowns open by default: those are what the page is for. */
const expanded = ref(new Set<string>())
watch(
  () => [compliance.framework, compliance.scopeId, compliance.report] as const,
  () => {
    expanded.value = new Set(
      compliance.summaries.filter((s) => s.status === 'gap' || s.status === 'unknown').map((s) => s.control.id),
    )
  },
  { immediate: true },
)

function toggle(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function byCheck(results: ComplianceResult[]) {
  const groups = new Map<string, ComplianceResult[]>()
  for (const result of results) {
    const list = groups.get(result.checkId)
    if (list) list.push(result)
    else groups.set(result.checkId, [result])
  }
  return [...groups].map(([checkId, list]) => ({ check: compliance.checkById.get(checkId), results: list }))
}

/** Per check, how many resources passed — the "what was verified" line for a met control. */
function passCounts(summary: ControlSummary) {
  return byCheck(summary.results.filter((r) => r.status === 'pass')).map((group) => ({
    title: group.check?.title ?? '',
    count: group.results.length,
  }))
}

function scoreLabel(score: FrameworkScore | null): string {
  if (!score || score.percent === null) return '—'
  return `${score.percent}%`
}

function openNode(nodeId: string): void {
  graph.select(nodeId)
  app.detailTab = 'compliance'
}

function nodeName(nodeId: string): string {
  const node = graph.nodeById.get(nodeId)
  return node ? graph.displayName(node) : nodeId
}

function exportGaps(): void {
  const report = compliance.report
  if (!report) return
  const scope = activeScope.value?.name ?? 'account'
  const date = new Date(report.scannedAt).toISOString().slice(0, 10)
  const slug = `${compliance.framework}-${scope}-${date}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  downloadText(`compliance-gaps-${slug}.csv`, gapsCsv(report, compliance.summaries, nodeName))
}

const hasGaps = computed(() => compliance.score.gap + compliance.score.unknown > 0)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[38px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <span class="text-[12.5px] font-semibold">Compliance</span>
      <CaPopover v-if="compliance.fullReport" :open="pickerOpen" width="320px" @close="pickerOpen = false">
        <template #trigger>
          <button
            type="button"
            class="flex h-[26px] cursor-pointer items-center gap-[6px] rounded-[6px] border border-border2 bg-panel2 px-[9px] text-[11.5px] text-muted hover:text-text"
            :aria-expanded="pickerOpen"
            @click="pickerOpen = !pickerOpen"
          >
            Frameworks
            <span class="font-mono text-[11px] text-text">{{ compliance.selected.length }}/{{ compliance.fullReport.frameworks.length }}</span>
            <span class="text-[10px] text-faint">▾</span>
          </button>
        </template>
        <template #content>
          <div class="px-[8px] pb-[6px] pt-[4px] text-[11px] leading-[1.5] text-faint">
            Measure this account only against what applies to it. Saved for account
            <span class="font-mono">{{ graph.graph?.accountId }}</span>.
          </div>
          <button
            v-for="option in compliance.fullReport.frameworks"
            :key="option.id"
            type="button"
            class="flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] px-[8px] py-[7px] text-left hover:bg-raise disabled:cursor-not-allowed"
            :disabled="compliance.selected.length === 1 && compliance.selected.includes(option.id)"
            :title="
              compliance.selected.length === 1 && compliance.selected.includes(option.id)
                ? 'At least one framework stays selected'
                : undefined
            "
            @click="compliance.toggleFramework(option.id)"
          >
            <CaCheckbox class="mt-[2px]" :checked="compliance.selected.includes(option.id)" />
            <span class="min-w-0">
              <span class="block text-[12.5px] font-medium text-text">{{ option.name }}</span>
              <span class="block text-[11px] leading-[1.45] text-muted">{{ option.description }}</span>
            </span>
          </button>
        </template>
      </CaPopover>
      <div
        v-if="compliance.mode === 'controls'"
        class="flex gap-px rounded-[7px] border border-border bg-panel2 p-[2px]"
        role="tablist"
      >
        <button
          v-for="framework in compliance.frameworks"
          :key="framework.id"
          type="button"
          role="tab"
          :aria-selected="compliance.framework === framework.id"
          class="h-[24px] cursor-pointer rounded-[5px] px-[10px] text-[11.5px] transition-colors"
          :class="
            compliance.framework === framework.id
              ? 'bg-raise font-semibold text-text'
              : 'text-muted hover:text-text'
          "
          @click="compliance.framework = framework.id"
        >
          {{ framework.name }}
        </button>
      </div>
      <span v-if="compliance.report" class="ml-auto text-[11.5px] text-muted">
        Evaluated against the scan from {{ relativeTime(compliance.report.scannedAt) }}
      </span>
      <button
        v-if="compliance.report"
        type="button"
        class="h-[26px] cursor-pointer rounded-[6px] border border-border2 bg-panel2 px-[10px] text-[11.5px] text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!hasGaps"
        :title="hasGaps ? 'One row per failing or unreadable resource, with evidence and remediation' : 'No gaps to export'"
        @click="exportGaps"
      >
        Export gaps (CSV)
      </button>
    </div>

    <CaEmptyState
      v-if="compliance.error"
      tone="error"
      class="flex-1"
      title="Could not evaluate compliance"
      :description="compliance.error"
    />
    <CaEmptyState
      v-else-if="!compliance.report"
      tone="pending"
      class="flex-1"
      :title="compliance.loading ? 'Evaluating…' : 'No scan to evaluate yet'"
    />

    <div v-else class="flex min-h-0 flex-1">
      <!-- Scopes -->
      <div class="flex w-[264px] shrink-0 flex-col gap-[6px] overflow-y-auto border-r border-border p-3">
        <div class="ca-eyebrow mb-1 px-1">Scope</div>
        <button
          v-for="card in scopeCards"
          :key="card.id ?? 'all'"
          type="button"
          class="cursor-pointer rounded-[9px] border px-[11px] py-[9px] text-left transition-colors"
          :class="
            compliance.scopeId === card.id
              ? 'border-border2 bg-raise'
              : 'border-border bg-panel hover:border-border2'
          "
          @click="compliance.scopeId = card.id"
        >
          <div class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{{ card.name }}</span>
            <span class="font-mono text-[12px] font-semibold">{{ scoreLabel(card.score) }}</span>
          </div>
          <div class="mt-[2px] truncate font-mono text-[10.5px] text-faint">{{ card.detail }}</div>
          <div class="mt-[7px] flex h-[4px] overflow-hidden rounded-full bg-border">
            <template v-if="card.score && card.score.percent !== null">
              <span :style="{ flex: card.score.met, background: 'var(--ca-ok)' }" />
              <span :style="{ flex: card.score.unknown, background: 'var(--ca-warn)' }" />
              <span :style="{ flex: card.score.gap, background: 'var(--ca-bad)' }" />
            </template>
          </div>
          <div class="mt-[6px] flex flex-wrap gap-x-[10px] text-[10.5px] text-muted">
            <span v-if="card.score && card.score.gap > 0" class="text-bad">
              ✕ {{ card.score.gap }} gap{{ card.score.gap === 1 ? '' : 's' }}
            </span>
            <span v-if="card.score && card.score.unknown > 0" class="text-warn">? {{ card.score.unknown }} unknown</span>
            <span>{{ card.count }} resources<template v-if="card.connected"> +{{ card.connected }} linked</template></span>
          </div>
        </button>
      </div>

      <div class="min-w-0 flex-1 overflow-y-auto p-4">
        <div class="mb-3 flex items-center gap-3">
          <div class="flex gap-px rounded-[7px] border border-border bg-panel2 p-[2px]" role="tablist">
            <button
              v-for="option in MODES"
              :key="option.id"
              type="button"
              role="tab"
              :aria-selected="compliance.mode === option.id"
              class="h-[26px] cursor-pointer rounded-[5px] px-[11px] text-[12px] transition-colors"
              :class="
                compliance.mode === option.id ? 'bg-raise font-semibold text-text' : 'text-muted hover:text-text'
              "
              @click="compliance.mode = option.id"
            >
              {{ option.label }}
              <span
                v-if="option.id === 'recommendations' && compliance.fixes.length"
                class="ml-[3px] font-mono text-[10.5px] text-bad"
                >{{ compliance.fixes.length }}</span
              >
            </button>
          </div>
          <span class="text-[11.5px] text-faint">{{ MODES.find((m) => m.id === compliance.mode)?.hint }}</span>
        </div>

        <ComplianceResources v-if="compliance.mode === 'resources'" @open="openNode" />
        <ComplianceRecommendations v-else-if="compliance.mode === 'recommendations'" @open="openNode" />

        <template v-else>
        <div class="mb-4 rounded-[10px] border border-border bg-panel p-[14px]">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-[22px] font-semibold leading-none">{{ scoreLabel(compliance.score) }}</span>
            <span class="text-[12.5px] text-muted">
              of {{ compliance.score.met + compliance.score.gap + compliance.score.unknown }} assessable
              {{ frameworkMeta?.name }} controls met
              <template v-if="activeScope"> in <span class="font-semibold text-text">{{ activeScope.name }}</span></template>
            </span>
            <span class="ml-auto text-[11px] text-faint">{{ frameworkMeta?.version }}</span>
          </div>
          <div class="mt-[10px] flex flex-wrap gap-[6px]">
            <span
              v-for="[status, count] in ([
                ['gap', compliance.score.gap],
                ['unknown', compliance.score.unknown],
                ['met', compliance.score.met],
                ['not-applicable', compliance.score.notApplicable],
                ['not-assessed', compliance.score.notAssessed],
              ] as const)"
              :key="status"
              class="flex items-center gap-[5px] rounded-full border border-border px-[9px] py-[2px] text-[11px]"
            >
              <span :style="{ color: CONTROL_STATUS[status].color }">{{ CONTROL_STATUS[status].glyph }}</span>
              <span class="text-muted">{{ CONTROL_STATUS[status].label }}</span>
              <span class="font-mono font-semibold">{{ count }}</span>
            </span>
          </div>
          <p class="mt-[10px] text-[11.5px] leading-[1.55] text-faint">
            Measured from resource configuration only. Controls marked Manual need evidence a scan
            cannot see, such as contracts, access reviews and account-level trails. This is an input
            to an assessment, not an attestation.
            <template v-if="activeScope?.kind === 'vpc' && activeScope.connectedNodeIds.length">
              Includes {{ activeScope.connectedNodeIds.length }} resource(s) outside the VPC that its
              workloads connect to.
            </template>
          </p>
        </div>

        <div class="flex flex-col gap-[8px]">
          <article
            v-for="summary in compliance.summaries"
            :key="summary.control.id"
            class="rounded-[10px] border border-border bg-panel"
          >
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-[10px] px-[14px] py-[10px] text-left"
              :aria-expanded="expanded.has(summary.control.id)"
              @click="toggle(summary.control.id)"
            >
              <span
                class="flex w-[92px] shrink-0 items-center gap-[5px] text-[11px] font-semibold"
                :style="{ color: CONTROL_STATUS[summary.status].color }"
              >
                <span>{{ CONTROL_STATUS[summary.status].glyph }}</span>
                {{ CONTROL_STATUS[summary.status].label }}
              </span>
              <span class="w-[150px] shrink-0 font-mono text-[11.5px] text-muted">{{ summary.control.ref }}</span>
              <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">{{ summary.control.title }}</span>
              <span class="shrink-0 text-[11px] text-faint">
                <template v-if="summary.failing.length">{{ summary.failing.length }} failing · </template>
                <template v-if="summary.unknown.length">{{ summary.unknown.length }} unknown · </template>
                <template v-if="summary.control.checkIds.length">{{ summary.passing }} passing</template>
                <template v-else>needs evidence</template>
              </span>
              <span class="w-[10px] shrink-0 text-[10px] text-faint">{{ expanded.has(summary.control.id) ? '▾' : '▸' }}</span>
            </button>

            <div v-if="expanded.has(summary.control.id)" class="border-t border-border px-[14px] pb-[12px] pt-[10px]">
              <p v-if="summary.control.coverageNote" class="mb-[10px] text-[11.5px] leading-[1.55] text-faint">
                <span class="font-semibold text-muted">{{ summary.control.checkIds.length ? 'Not covered: ' : 'Evidence needed: ' }}</span>
                {{ summary.control.coverageNote }}
              </p>

              <section
                v-for="group in byCheck([...summary.failing, ...summary.unknown])"
                :key="group.check?.id"
                class="mb-[12px] last:mb-0"
              >
                <div class="flex items-center gap-2">
                  <span class="text-[12.5px] font-semibold">{{ group.check?.title }}</span>
                  <span
                    v-if="group.check"
                    class="rounded-full border px-[7px] text-[10px] uppercase tracking-wide"
                    :style="{ color: SEVERITY_COLOR[group.check.severity], borderColor: 'var(--ca-border2)' }"
                  >
                    {{ group.check.severity }}
                  </span>
                </div>
                <p class="mt-[4px] text-[11.5px] leading-[1.55] text-muted">{{ group.check?.rationale }}</p>

                <ul class="mt-[8px] flex flex-col gap-[4px]">
                  <li v-for="result in group.results" :key="result.nodeId">
                    <button
                      type="button"
                      class="flex w-full cursor-pointer items-start gap-[9px] rounded-[7px] border border-border bg-panel2 px-[9px] py-[7px] text-left hover:border-border2"
                      @click="openNode(result.nodeId)"
                    >
                      <CaTile
                        v-if="graph.nodeById.get(result.nodeId)"
                        :abbr="graph.nodeById.get(result.nodeId)!.abbr"
                        :color="nodeColor(graph.nodeById.get(result.nodeId)!)"
                        :node-type="graph.nodeById.get(result.nodeId)!.type"
                        :size="22"
                        :radius="5"
                      />
                      <span class="min-w-0 flex-1">
                        <span class="flex items-baseline gap-2">
                          <span class="truncate text-[12px] font-medium">{{ nodeName(result.nodeId) }}</span>
                          <span
                            class="text-[10.5px] font-semibold"
                            :style="{ color: result.status === 'fail' ? 'var(--ca-bad)' : 'var(--ca-warn)' }"
                          >
                            {{ result.status === 'fail' ? 'fails' : 'not readable' }}
                          </span>
                        </span>
                        <span
                          v-for="(line, index) in result.evidence"
                          :key="index"
                          class="block font-mono text-[10.5px] text-faint"
                        >· {{ line }}</span>
                      </span>
                    </button>
                  </li>
                </ul>
                <div class="mt-[7px] font-mono text-[10.5px] leading-[1.5] text-muted">
                  <span class="font-sans font-semibold">Fix:</span> {{ group.check?.remediation }}
                </div>
                <FixCommands
                  v-if="fixScript(group.check, group.results, nodeName)"
                  class="mt-[8px]"
                  collapsible
                  :label="`${group.results.filter((r) => r.fix).length} resource(s), identifiers filled in`"
                  :script="fixScript(group.check, group.results, nodeName)"
                  :needs-input="group.results.some((r) => r.fix?.needsInput)"
                />
              </section>

              <div v-if="summary.passing > 0" class="mt-[4px] flex flex-col gap-[2px]">
                <span
                  v-for="line in passCounts(summary)"
                  :key="line.title"
                  class="text-[11px] text-faint"
                >
                  <span style="color: var(--ca-ok)">✓</span> {{ line.title }} — {{ line.count }}
                  resource{{ line.count === 1 ? '' : 's' }}
                </span>
              </div>
              <p v-if="summary.status === 'not-applicable'" class="text-[11.5px] text-faint">
                No resource in this scope is of a type these checks apply to.
              </p>
            </div>
          </article>
        </div>
        </template>
      </div>
    </div>
  </div>
</template>
