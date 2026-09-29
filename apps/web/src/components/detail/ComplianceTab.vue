<script setup lang="ts">
import { computed } from 'vue'
import { scoreControls, scoreResults, summarizeControls, type GraphNode } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useComplianceStore } from '@/stores/compliance'
import { SEVERITY_COLOR } from '@/lib/compliance'
import FixCommands from '../compliance/FixCommands.vue'
import CaEmptyState from '../ui/CaEmptyState.vue'

const props = defineProps<{ node: GraphNode }>()
const app = useAppStore()
const compliance = useComplianceStore()

const STATUS_ORDER = { fail: 0, unknown: 1, pass: 2 } as const
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

/** Failing checks first, most severe first: the top card is the next thing to fix. */
const results = computed(() =>
  [...(compliance.resultsByNode.get(props.node.id) ?? [])].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      SEVERITY_ORDER[compliance.checkById.get(a.checkId)?.severity ?? 'low'] -
        SEVERITY_ORDER[compliance.checkById.get(b.checkId)?.severity ?? 'low'],
  ),
)

const score = computed(() => scoreResults(results.value))

/** "HIPAA §164.312(b)", for every control a check evidences. */
function controlsFor(checkId: string): string[] {
  return compliance.frameworks.flatMap((framework) =>
    framework.controls
      .filter((control) => control.checkIds.includes(checkId))
      .map((control) => `${framework.name} ${control.ref}`),
  )
}

/** On a VPC, the scope it heads: its score in every framework. */
const vpcScores = computed(() => {
  const report = compliance.report
  if (!report || props.node.type !== 'vpc') return []
  if (!report.scopes.some((scope) => scope.id === props.node.id)) return []
  return report.frameworks.map((framework) => ({
    id: framework.id,
    name: framework.name,
    score: scoreControls(summarizeControls(report, framework.id, props.node.id)),
  }))
})

function openScope(frameworkId: (typeof vpcScores.value)[number]['id']): void {
  compliance.framework = frameworkId
  compliance.scopeId = props.node.id
  app.setView('compliance')
}

const STATUS_STYLE = {
  fail: { glyph: '✕', label: 'Fails', color: 'var(--ca-bad)' },
  unknown: { glyph: '?', label: 'Not readable', color: 'var(--ca-warn)' },
  pass: { glyph: '✓', label: 'Passes', color: 'var(--ca-ok)' },
} as const
</script>

<template>
  <div class="flex flex-col gap-4">
    <section v-if="vpcScores.length > 0">
      <div class="ca-eyebrow mb-2">This VPC and its resources</div>
      <div class="flex flex-col gap-[6px]">
        <button
          v-for="row in vpcScores"
          :key="row.id"
          type="button"
          class="flex cursor-pointer items-center gap-[10px] rounded-[8px] border border-border bg-panel2 px-[10px] py-[8px] text-left hover:border-border2"
          :title="`Open the ${row.name} report for this VPC`"
          @click="openScope(row.id)"
        >
          <span class="w-[70px] text-[12px] font-semibold">{{ row.name }}</span>
          <span class="font-mono text-[12px]">{{ row.score.percent === null ? '—' : `${row.score.percent}%` }}</span>
          <span class="ml-auto text-[11px]">
            <span v-if="row.score.gap" class="text-bad">✕ {{ row.score.gap }} gap{{ row.score.gap === 1 ? '' : 's' }}</span>
            <span v-else-if="row.score.unknown" class="text-warn">? {{ row.score.unknown }} unknown</span>
            <span v-else class="text-ok">✓ no gaps</span>
          </span>
          <span class="text-[10px] text-faint">▸</span>
        </button>
      </div>
    </section>

    <CaEmptyState
      v-if="!compliance.report"
      tone="pending"
      :title="compliance.loading ? 'Evaluating…' : 'Compliance not evaluated yet'"
    />
    <CaEmptyState
      v-else-if="results.length === 0"
      title="No checks apply"
      :description="`None of the automated compliance checks apply to a ${node.typeLabel}.`"
    />

    <section v-else>
      <div class="mb-4 rounded-[8px] border border-border bg-panel2 px-[11px] py-[10px]">
        <div class="flex items-baseline gap-2">
          <span class="ca-eyebrow">Benchmark</span>
          <span
            class="ml-auto font-mono text-[15px] font-semibold"
            :style="{ color: score.fail ? 'var(--ca-bad)' : score.unknown ? 'var(--ca-warn)' : 'var(--ca-ok)' }"
          >
            {{ score.percent === null ? '—' : `${score.percent}%` }}
          </span>
        </div>
        <div class="mt-[6px] flex h-[5px] overflow-hidden rounded-full bg-border">
          <span :style="{ flex: score.pass, background: 'var(--ca-ok)' }" />
          <span :style="{ flex: score.unknown, background: 'var(--ca-warn)' }" />
          <span :style="{ flex: score.fail, background: 'var(--ca-bad)' }" />
        </div>
        <div class="mt-[6px] text-[11px] text-muted">
          {{ score.pass }} of {{ score.total }} checks pass
          <template v-if="score.fail"> · <span class="text-bad">{{ score.fail }} to fix</span></template>
          <template v-if="score.unknown"> · <span class="text-warn">{{ score.unknown }} not readable</span></template>
        </div>
      </div>

      <div class="ca-eyebrow mb-2">{{ score.fail ? 'Recommendations, then passing checks' : 'Checks on this resource' }}</div>
      <div class="flex flex-col gap-[8px]">
        <article
          v-for="result in results"
          :key="result.checkId"
          class="rounded-[8px] border border-border bg-panel2 px-[10px] py-[9px]"
        >
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-semibold" :style="{ color: STATUS_STYLE[result.status].color }">
              {{ STATUS_STYLE[result.status].glyph }} {{ STATUS_STYLE[result.status].label }}
            </span>
            <span
              v-if="compliance.checkById.get(result.checkId) && result.status !== 'pass'"
              class="ml-auto rounded-full border border-border2 px-[6px] text-[9.5px] uppercase tracking-wide"
              :style="{ color: SEVERITY_COLOR[compliance.checkById.get(result.checkId)!.severity] }"
            >
              {{ compliance.checkById.get(result.checkId)!.severity }}
            </span>
          </div>
          <div class="mt-[3px] text-[12.5px] font-medium">
            <span v-if="compliance.benchmarkRef.get(result.checkId)" class="mr-[5px] font-mono text-[11px] text-muted">{{
              compliance.benchmarkRef.get(result.checkId)
            }}</span>
            {{ compliance.checkById.get(result.checkId)?.title ?? result.checkId }}
          </div>
          <p v-if="result.status === 'fail'" class="mt-[3px] text-[11.5px] leading-[1.5] text-muted">
            {{ compliance.checkById.get(result.checkId)?.rationale }}
          </p>
          <div
            v-for="(line, index) in result.evidence"
            :key="index"
            class="font-mono text-[10.5px] text-faint"
          >
            · {{ line }}
          </div>
          <template v-if="result.status === 'fail'">
            <FixCommands
              v-if="result.fix"
              class="mt-[8px]"
              :script="result.fix.commands.join('\n')"
              :caution="result.fix.caution"
              :needs-input="result.fix.needsInput"
            />
            <!-- No command-line fix exists (a migration, not a flag): the
                 written remediation is the whole answer, so say so. -->
            <p v-else class="mt-[6px] text-[11px] leading-[1.5] text-muted">
              <span class="font-semibold">No single command fixes this.</span>
              {{ compliance.checkById.get(result.checkId)?.remediation }}
            </p>
          </template>
          <div class="mt-[6px] flex flex-wrap gap-[4px]">
            <span
              v-for="control in controlsFor(result.checkId)"
              :key="control"
              class="rounded-[4px] bg-raise px-[5px] py-px font-mono text-[9.5px] text-muted"
            >
              {{ control }}
            </span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
