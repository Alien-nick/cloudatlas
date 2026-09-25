<script setup lang="ts">
import { computed } from 'vue'
import { SECTION_LABELS, type CollectorSection, type Finding } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import { nodeColor, relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaScanNotice from '../ui/CaScanNotice.vue'
import CaSparkline from '../ui/CaSparkline.vue'
import CaTile from '../ui/CaTile.vue'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const groups = computed(() => [
  {
    id: 'critical',
    label: 'Critical',
    color: 'var(--ca-bad)',
    findings: health.incidents.filter((f) => f.severity === 'critical'),
  },
  {
    id: 'warning',
    label: 'Warning',
    color: 'var(--ca-warn)',
    findings: health.incidents.filter((f) => f.severity === 'warning'),
  },
  {
    id: 'posture',
    label: 'Posture',
    color: 'var(--ca-muted)',
    findings: health.posture,
  },
])

const sectionLabel = (section: string): string =>
  SECTION_LABELS[section as CollectorSection] ?? section

function open(finding: Finding, tab: 'metrics' | 'security' | 'logs'): void {
  graph.select(finding.nodeId)
  app.detailTab = tab
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[38px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <span class="text-[12.5px] font-semibold">Health</span>
      <span class="text-[11.5px] text-faint">
        {{ health.criticalCount }} critical · {{ health.warningCount }} warning
      </span>
      <span v-if="health.evaluatedAt" class="ml-auto text-[11.5px] text-muted">
        Evaluated {{ relativeTime(health.evaluatedAt) }}
      </span>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      <!-- What the scan could not see. Separate from findings on purpose: a
           finding is something we detected, this is something we could not. -->
      <section v-if="graph.hasScanIssues" class="mb-6">
        <div class="mb-[10px] flex items-center gap-2">
          <span class="h-[7px] w-[7px] rounded-full" style="background: var(--ca-warn)" />
          <span class="ca-eyebrow !text-[11px]">Incomplete scan</span>
          <span class="text-[11px] text-faint">{{ graph.affectedSections.length }} section(s)</span>
        </div>
        <div class="flex flex-col gap-[10px]">
          <div v-for="section in graph.affectedSections" :key="section">
            <div class="mb-[5px] text-[11.5px] font-semibold text-muted">
              {{ sectionLabel(section) }}
            </div>
            <CaScanNotice
              :permissions="graph.permissionsForSection(section)"
              :failures="graph.failuresForSection(section)"
              :affects="sectionLabel(section)"
            />
          </div>
        </div>
      </section>

      <CaEmptyState
        v-if="health.error"
        tone="error"
        title="Could not evaluate health"
        :description="health.error"
      />
      <CaEmptyState
        v-else-if="health.findings.length === 0 && !health.loading && !graph.hasScanIssues"
        title="No open findings"
        description="No CloudWatch alarm is firing, no metric anomaly was detected, and no security group exposes a sensitive port."
        glyph="✓"
      />

      <div v-else class="flex flex-col gap-6">
        <section v-for="group in groups" :key="group.id" v-show="group.findings.length > 0">
          <div class="mb-[10px] flex items-center gap-2">
            <span class="h-[7px] w-[7px] rounded-full" :style="{ background: group.color }" />
            <span class="ca-eyebrow !text-[11px]">{{ group.label }}</span>
            <span class="text-[11px] text-faint">{{ group.findings.length }}</span>
          </div>

          <div class="flex flex-col gap-[10px]">
            <article
              v-for="finding in group.findings"
              :key="finding.id"
              class="rounded-[10px] border border-border bg-panel p-[14px]"
            >
              <div class="flex items-start gap-[11px]">
                <CaTile
                  v-if="graph.nodeById.get(finding.nodeId)"
                  :abbr="graph.nodeById.get(finding.nodeId)!.abbr"
                  :color="nodeColor(graph.nodeById.get(finding.nodeId)!)"
                  :node-type="graph.nodeById.get(finding.nodeId)!.type"
                  :size="28"
                  :radius="7"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span class="text-[13px] font-semibold">{{ finding.title }}</span>
                    <span class="font-mono text-[11px] text-faint">{{ finding.nodeId }}</span>
                    <span class="ml-auto text-[11px] whitespace-nowrap text-muted">
                      started {{ relativeTime(finding.startedAt) }}
                    </span>
                  </div>
                  <p class="mt-[6px] text-[12px] leading-[1.6] text-muted">{{ finding.detail }}</p>

                  <ul v-if="finding.evidence.length > 0" class="mt-[9px] flex flex-col gap-[3px]">
                    <li
                      v-for="(item, index) in finding.evidence"
                      :key="index"
                      class="font-mono text-[11px] text-faint"
                    >
                      · {{ item }}
                    </li>
                  </ul>
                </div>
              </div>

              <div
                v-if="finding.sparkline.length > 1"
                class="mt-[10px] rounded-[8px] border border-border bg-panel2 px-[10px] pb-1 pt-[8px]"
              >
                <div class="mb-1 font-mono text-[10.5px] text-faint">{{ finding.metric }}</div>
                <CaSparkline
                  :values="finding.sparkline"
                  :color="group.id === 'critical' ? 'var(--ca-bad)' : 'var(--ca-warn)'"
                  :height="38"
                />
              </div>

              <div class="mt-[11px] flex flex-wrap gap-[6px]">
                <button
                  v-if="finding.metric"
                  type="button"
                  class="h-[26px] cursor-pointer rounded-[6px] border border-border2 bg-panel2 px-[10px] text-[11.5px] text-muted hover:text-text"
                  @click="open(finding, 'metrics')"
                >
                  View metrics
                </button>
                <button
                  v-if="finding.logGroups.length > 0"
                  type="button"
                  class="h-[26px] cursor-pointer rounded-[6px] border border-border2 bg-panel2 px-[10px] text-[11.5px] text-muted hover:text-text"
                  @click="open(finding, 'logs')"
                >
                  View logs
                </button>
                <button
                  v-if="finding.kind === 'risky-sg-rule'"
                  type="button"
                  class="h-[26px] cursor-pointer rounded-[6px] border border-border2 bg-panel2 px-[10px] text-[11.5px] text-muted hover:text-text"
                  @click="open(finding, 'security')"
                >
                  View rules
                </button>
                <button
                  type="button"
                  disabled
                  class="h-[26px] cursor-not-allowed rounded-[6px] border border-border bg-panel2 px-[10px] text-[11.5px] text-faint"
                  title="The Claude agent arrives in Milestone 5"
                >
                  Ask Claude
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
