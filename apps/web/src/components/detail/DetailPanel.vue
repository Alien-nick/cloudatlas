<script setup lang="ts">
import { computed, watch, ref } from 'vue'
import { useAppStore, type DetailTab } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { copyText, nodeColor } from '@/lib/utils'
import CaStatePill from '../ui/CaStatePill.vue'
import CaTile from '../ui/CaTile.vue'
import ConnectionsTab from './ConnectionsTab.vue'
import JsonTab from './JsonTab.vue'
import LogsTab from './LogsTab.vue'
import WafTab from './WafTab.vue'
import DbLoadTab from './DbLoadTab.vue'
import MetricsTab from './MetricsTab.vue'
import OverviewTab from './OverviewTab.vue'
import SecurityTab from './SecurityTab.vue'
import TagsTab from './TagsTab.vue'

const app = useAppStore()
const graph = useGraphStore()

/** WAF's sampled-requests tab only applies to a web ACL, so it is filtered. */
const ALL_TABS: Array<{ id: DetailTab; label: string; only?: string[] }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'logs', label: 'Logs' },
  { id: 'waf', label: 'Requests', only: ['waf-web-acl'] },
  { id: 'db-load', label: 'Load', only: ['rds'] },
  { id: 'connections', label: 'Connections' },
  { id: 'security', label: 'Security' },
  { id: 'tags', label: 'Tags' },
  { id: 'json', label: 'JSON' },
]

const node = computed(() => graph.selectedNode)

const TABS = computed(() =>
  ALL_TABS.filter((tab) => !tab.only || (node.value && tab.only.includes(node.value.type))),
)

/**
 * Fall back to Overview when the active tab does not apply to the new node.
 *
 * The canvas resets the tab on click, but selection also happens from the
 * inventory list and from search. Without this, moving from a web ACL to
 * anything else leaves a tab selected that has nothing to render — an empty
 * panel that reads as a broken page rather than as a tab that does not apply.
 */
watch(TABS, (tabs) => {
  if (!tabs.some((tab) => tab.id === app.detailTab)) app.detailTab = 'overview'
})
const copied = ref<'arn' | 'ssm' | null>(null)

const canSsm = computed(() => node.value?.type === 'ec2')

const ssmCommand = computed(() => {
  const current = node.value
  if (!current) return ''
  const instanceId = current.props.find((p) => p.k === 'Instance ID')?.v ?? current.name
  return `aws ssm start-session --target ${instanceId} --profile ${app.profile} --region ${current.region}`
})

async function copy(kind: 'arn' | 'ssm'): Promise<void> {
  const text = kind === 'arn' ? (node.value?.arn ?? '') : ssmCommand.value
  if (!text) return
  if (await copyText(text)) {
    copied.value = kind
    window.setTimeout(() => {
      if (copied.value === kind) copied.value = null
    }, 1600)
  }
}
</script>

<template>
  <aside
    v-if="node"
    class="flex w-[372px] shrink-0 flex-col border-l border-border bg-panel min-h-0"
    style="flex-basis: 372px"
  >
    <div class="border-b border-border px-4 pb-3 pt-[14px]">
      <div class="flex items-start gap-[11px]">
        <CaTile :abbr="node.abbr" :color="nodeColor(node)" :node-type="node.type" :size="36" :radius="8" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="min-w-0 truncate text-[14.5px] font-semibold" :title="node.name">{{
              node.name
            }}</span>
            <CaStatePill :state="node.state" big />
          </div>
          <div class="mt-[2px] text-[12px] text-muted">
            {{ node.typeLabel }} · {{ node.az ?? node.region }}
          </div>
        </div>
        <button
          type="button"
          class="cursor-pointer border-none bg-transparent text-[14px] leading-none text-faint hover:text-text"
          title="Close panel"
          @click="graph.select(null)"
        >
          ✕
        </button>
      </div>

      <div
        v-if="node.arn"
        class="mt-[11px] flex items-center gap-2 rounded-[7px] border border-border bg-panel2 px-[9px] py-[7px]"
      >
        <span
          class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted"
          :title="node.arn"
          >{{ node.arn }}</span
        >
        <button
          type="button"
          class="cursor-pointer rounded-[5px] border border-border2 bg-transparent px-[7px] py-[2px] text-[10.5px] text-muted hover:text-text"
          @click="copy('arn')"
        >
          {{ copied === 'arn' ? 'Copied' : 'Copy' }}
        </button>
      </div>

      <!-- The panel is for glancing while the diagram is in view; this opens
           the same resource laid out for reading. -->
      <button
        type="button"
        class="mt-[9px] flex h-[32px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-border2 bg-raise text-[12.5px] font-medium text-text hover:border-text"
        @click="app.openResource()"
      >
        View details
      </button>

      <button
        v-if="canSsm"
        type="button"
        class="mt-[9px] flex h-[32px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-border2 bg-raise text-[12.5px] font-medium text-text hover:border-text"
        :title="`Copies: ${ssmCommand}\n\nCloudAtlas is read-only and has no in-browser shell — run the command in your terminal.`"
        @click="copy('ssm')"
      >
        <span class="font-mono text-[11px] text-muted">▸_</span>
        <span>{{
          copied === 'ssm' ? 'Command copied to clipboard' : 'Session Manager command'
        }}</span>
      </button>
    </div>

    <div class="ca-scroll-none flex gap-px overflow-x-auto border-b border-border px-2 py-[6px]">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="shrink-0 cursor-pointer rounded-[6px] px-[6px] py-[5px] text-[11.5px] whitespace-nowrap transition-colors"
        :class="
          app.detailTab === tab.id
            ? 'bg-raise font-semibold text-text'
            : 'font-normal text-muted hover:text-text'
        "
        @click="app.detailTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-[18px] pt-[14px]">
      <OverviewTab v-if="app.detailTab === 'overview'" :node="node" />
      <MetricsTab v-else-if="app.detailTab === 'metrics'" :key="node.id" :node="node" />
      <LogsTab v-else-if="app.detailTab === 'logs'" :node="node" />
      <WafTab v-else-if="app.detailTab === 'waf'" :key="node.id" :node="node" />
      <DbLoadTab v-else-if="app.detailTab === 'db-load'" :key="node.id" :node="node" />
      <ConnectionsTab v-else-if="app.detailTab === 'connections'" :node="node" />
      <SecurityTab v-else-if="app.detailTab === 'security'" :node="node" />
      <TagsTab v-else-if="app.detailTab === 'tags'" :node="node" />
      <JsonTab v-else-if="app.detailTab === 'json'" :node="node" />
    </div>
  </aside>
</template>
