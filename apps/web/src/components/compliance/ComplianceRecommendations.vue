<script setup lang="ts">
import { ref } from 'vue'
import type { ComplianceControl } from '@cloudatlas/shared'
import { useComplianceStore } from '@/stores/compliance'
import { useGraphStore } from '@/stores/graph'
import { SEVERITY_COLOR, fixScript } from '@/lib/compliance'
import CaEmptyState from '../ui/CaEmptyState.vue'
import FixCommands from './FixCommands.vue'

/**
 * What to fix, in order.
 *
 * One card per failing check rather than per resource: the same fix usually
 * applies to every instance it names, and "require IMDSv2 on these five
 * instances" is one piece of work, not five.
 */

const emit = defineEmits<{ open: [nodeId: string] }>()
const compliance = useComplianceStore()
const graph = useGraphStore()

const PREVIEW = 8
const expanded = ref(new Set<string>())

function frameworkName(control: ComplianceControl): string {
  return compliance.frameworks.find((framework) => framework.id === control.framework)?.name ?? control.framework
}

function nodeName(nodeId: string): string {
  const node = graph.nodeById.get(nodeId)
  return node ? graph.displayName(node) : nodeId
}

function showAll(checkId: string): void {
  expanded.value = new Set([...expanded.value, checkId])
}

</script>

<template>
  <CaEmptyState
    v-if="compliance.fixes.length === 0"
    glyph="✓"
    title="Nothing to fix in this scope"
    description="No automated check is failing. Controls marked Manual still need evidence from outside the scan."
  />

  <ol v-else class="flex flex-col gap-[10px]">
    <li
      v-for="(fix, index) in compliance.fixes"
      :key="fix.check.id"
      class="rounded-[10px] border border-border bg-panel p-[14px]"
    >
      <div class="flex items-start gap-[11px]">
        <span class="mt-[1px] font-mono text-[12px] font-semibold text-faint">{{ index + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[13px] font-semibold">{{ fix.check.title }}</span>
            <span
              class="rounded-full border border-border2 px-[7px] text-[10px] uppercase tracking-wide"
              :style="{ color: SEVERITY_COLOR[fix.check.severity] }"
            >
              {{ fix.check.severity }}
            </span>
            <span class="ml-auto text-[11.5px] text-muted">
              fixes {{ fix.failing.length }} resource{{ fix.failing.length === 1 ? '' : 's' }} ·
              closes evidence for {{ fix.controls.length }} control{{ fix.controls.length === 1 ? '' : 's' }}
            </span>
          </div>
          <p class="mt-[5px] text-[12px] leading-[1.55] text-muted">{{ fix.check.rationale }}</p>

          <p class="mt-[7px] text-[11.5px] leading-[1.5] text-muted">
            <span class="font-semibold text-text">{{ fixScript(fix.check, fix.failing, nodeName) ? 'How:' : 'No single command fixes this:' }}</span>
            {{ fix.check.remediation }}
          </p>
          <FixCommands
            v-if="fixScript(fix.check, fix.failing, nodeName)"
            class="mt-[9px]"
            :label="`all ${fix.failing.filter((r) => r.fix).length} resource(s), identifiers filled in`"
            :script="fixScript(fix.check, fix.failing, nodeName)"
            :caution="fix.failing.find((r) => r.fix)?.fix?.caution ?? null"
            :needs-input="fix.failing.some((r) => r.fix?.needsInput)"
          />

          <div class="mt-[9px] flex flex-wrap gap-[4px]">
            <button
              v-for="result in expanded.has(fix.check.id) ? fix.failing : fix.failing.slice(0, PREVIEW)"
              :key="result.nodeId"
              type="button"
              class="cursor-pointer rounded-[5px] border border-border2 bg-raise px-[7px] py-[2px] text-[11px] text-text hover:border-text"
              :title="result.evidence.join('\n')"
              @click="emit('open', result.nodeId)"
            >
              {{ nodeName(result.nodeId) }}
            </button>
            <button
              v-if="!expanded.has(fix.check.id) && fix.failing.length > PREVIEW"
              type="button"
              class="cursor-pointer px-[4px] text-[11px] text-muted hover:text-text"
              @click="showAll(fix.check.id)"
            >
              +{{ fix.failing.length - PREVIEW }} more
            </button>
          </div>

          <div class="mt-[9px] flex flex-wrap gap-[4px]">
            <span
              v-for="control in fix.controls"
              :key="control.id"
              class="rounded-[4px] bg-raise px-[5px] py-px font-mono text-[9.5px] text-muted"
              :title="control.title"
            >
              {{ frameworkName(control) }} {{ control.ref }}
            </span>
          </div>
        </div>
      </div>
    </li>
  </ol>
</template>
