<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { relativeTime } from '@/lib/utils'
import CaButton from './ui/CaButton.vue'
import CaCheckbox from './ui/CaCheckbox.vue'
import CaPopover from './ui/CaPopover.vue'
import HealthStrip from './HealthStrip.vue'

const app = useAppStore()
const graph = useGraphStore()

const emit = defineEmits<{ reconnect: []; search: [] }>()

const regionsOpen = ref(false)
const accountOpen = ref(false)

const regionSummary = computed(() => {
  const regions = graph.selectedRegions
  if (regions.length === 0) return 'none'
  return regions.length > 1 ? `${regions[0]} +${regions.length - 1}` : (regions[0] ?? '')
})

const syncLabel = computed(() => {
  if (graph.scanning) return 'Syncing…'
  if (!graph.lastScanAt) return 'Not scanned'
  return `Synced ${relativeTime(graph.lastScanAt)}`
})

/** "2 missing permissions · 1 unknown" — both kinds, counted separately. */
const scanIssueLabel = computed(() => {
  const parts: string[] = []
  if (graph.missingActions > 0) {
    parts.push(`${graph.missingActions} missing permission${graph.missingActions === 1 ? '' : 's'}`)
  }
  if (graph.collectorFailures.length > 0) {
    parts.push(`${graph.collectorFailures.length} unknown`)
  }
  return parts.join(' · ')
})

function refresh(): void {
  if (!graph.scanning && app.profile) void graph.refresh(app.profile)
}

function selectProfile(name: string): void {
  app.profile = name
  accountOpen.value = false
  emit('reconnect')
}
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-3"
  >
    <div class="flex items-center gap-2 pr-1">
      <div
        class="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-[11px] font-bold text-white"
        style="background: linear-gradient(140deg, #ed7100, #e7157b)"
      >
        C
      </div>
      <div class="text-[13.5px] font-semibold">CloudAtlas</div>
    </div>

    <!-- Account / profile switcher -->
    <CaPopover :open="accountOpen" width="240px" @close="accountOpen = false">
      <template #trigger>
        <CaButton :active="accountOpen" @click="accountOpen = !accountOpen">
          <span class="h-[6px] w-[6px] rounded-full" :class="app.identity ? 'bg-ok' : 'bg-warn'" />
          <span class="max-w-[160px] truncate font-medium">{{ app.accountLabel }}</span>
          <span class="text-faint">·</span>
          <span class="whitespace-nowrap font-mono text-[11.5px] text-muted">{{
            app.accountId
          }}</span>
          <span class="text-[10px] text-faint">▾</span>
        </CaButton>
      </template>
      <template #content>
        <div class="ca-eyebrow px-2 pb-[6px] pt-1">Profile</div>
        <button
          v-for="candidate in app.profiles"
          :key="candidate.name"
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[6px] text-left font-mono text-[12px] hover:bg-raise"
          @click="selectProfile(candidate.name)"
        >
          <span :class="candidate.name === app.profile ? 'text-text' : 'text-muted'">{{
            candidate.name
          }}</span>
          <span v-if="candidate.sso" class="ml-auto text-[10px] text-faint">SSO</span>
        </button>
        <p v-if="app.profiles.length === 0" class="px-2 py-2 text-[11.5px] text-muted">
          No profiles found in ~/.aws.
        </p>
      </template>
    </CaPopover>

    <!-- Region picker -->
    <CaPopover :open="regionsOpen" @close="regionsOpen = false">
      <template #trigger>
        <CaButton :active="regionsOpen" @click="regionsOpen = !regionsOpen">
          <span class="text-muted">Regions</span>
          <span class="font-mono text-[11.5px]">{{ regionSummary }}</span>
          <span class="text-[10px] text-faint">▾</span>
        </CaButton>
      </template>
      <template #content>
        <button
          v-for="region in graph.regionOptions"
          :key="region.id"
          type="button"
          class="flex w-full cursor-pointer items-center gap-[9px] rounded-[6px] px-2 py-[7px] text-[12.5px] hover:bg-raise"
          @click="graph.toggleRegion(region.id)"
        >
          <CaCheckbox :checked="graph.selectedRegions.includes(region.id)" />
          <span class="font-mono text-[11.5px]">{{ region.id }}</span>
          <span class="ml-auto text-[11px] text-faint">{{ region.count }}</span>
        </button>
        <p v-if="graph.regionOptions.length === 0" class="px-2 py-2 text-[11.5px] text-muted">
          Run a scan to discover regions.
        </p>
      </template>
    </CaPopover>

    <!-- Search -->
    <div class="flex flex-1 justify-center">
      <button
        type="button"
        class="flex h-[30px] w-[420px] max-w-full cursor-pointer items-center gap-2 rounded-[7px] border border-border bg-panel2 px-[10px] text-muted transition-colors hover:border-border2"
        @click="emit('search')"
      >
        <span class="text-[12px] opacity-70">⌕</span>
        <span class="text-[12.5px]">Search ARN, name, or tag</span>
        <span class="ml-auto flex gap-[3px]">
          <kbd class="rounded-[4px] border border-border2 px-[5px] py-[2px] font-mono text-[10.5px]"
            >⌘</kbd
          >
          <kbd class="rounded-[4px] border border-border2 px-[5px] py-[2px] font-mono text-[10.5px]"
            >K</kbd
          >
        </span>
      </button>
    </div>

    <HealthStrip />

    <!-- Incomplete-scan indicator. Deliberately not red: nothing is broken,
         the picture is just missing pieces. -->
    <button
      v-if="graph.hasScanIssues"
      type="button"
      class="flex h-[30px] shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[7px] border bg-panel2 px-[9px] text-[12px] transition-colors hover:bg-raise"
      style="border-color: rgba(210, 153, 34, 0.45); color: var(--ca-warn)"
      title="Some sections could not be collected. Open the Health view for detail."
      @click="app.setView('health')"
    >
      <span class="h-[6px] w-[6px] rounded-full" style="background: var(--ca-warn)" />
      {{ scanIssueLabel }}
    </button>

    <!-- Sync status -->
    <div
      class="flex h-[30px] items-center gap-[7px] rounded-[7px] border border-border bg-panel2 px-[10px]"
    >
      <span
        class="h-[6px] w-[6px] rounded-full"
        :class="graph.scanning ? 'bg-warn' : graph.lastScanAt ? 'bg-ok' : 'bg-faint'"
      />
      <span class="text-[12.5px] whitespace-nowrap text-muted">{{ syncLabel }}</span>
      <button
        type="button"
        class="cursor-pointer border-none bg-transparent pl-[2px] text-[13px] leading-none text-muted hover:text-text"
        title="Re-scan the selected regions"
        @click="refresh"
      >
        <span
          class="inline-block"
          :style="{ animation: graph.scanning ? 'ca-spin 1s linear infinite' : undefined }"
          >⟳</span
        >
      </button>
    </div>

    <CaButton
      variant="ghost"
      :title="app.info?.agentReady ? 'Ask Claude about this account' : 'Set ANTHROPIC_API_KEY to enable'"
      @click="app.agentOpen = !app.agentOpen"
    >
      Ask Claude
    </CaButton>
    <CaButton variant="ghost" @click="emit('reconnect')">Reconnect</CaButton>
    <CaButton
      variant="icon"
      :title="app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
      @click="app.toggleTheme()"
    >
      {{ app.theme === 'dark' ? '☾' : '☀' }}
    </CaButton>
  </header>
</template>
