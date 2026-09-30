<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import type { AddCredentialsResponse } from '@cloudatlas/shared'
import { api } from '@/lib/api'
import CaButton from '../ui/CaButton.vue'
import CaCheckbox from '../ui/CaCheckbox.vue'
import AccessKeyForm from './AccessKeyForm.vue'

const app = useAppStore()
const graph = useGraphStore()

const profilesOpen = ref(false)
const regions = ref<string[]>([...(app.info?.defaultRegions ?? ['us-east-1'])])
let regionsTouched = false

// This screen renders before /api/info resolves, so adopt the configured
// defaults when they arrive — unless the user has already picked regions.
watch(
  () => app.info?.defaultRegions,
  (defaults) => {
    if (!defaults || regionsTouched) return
    regions.value = [...defaults]
  },
)

const availableRegions = computed(() => {
  const discovered = graph.regionOptions.map((r) => r.id)
  if (discovered.length > 0) return discovered
  return [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'eu-west-1',
    'eu-central-1',
    'ap-southeast-1',
    'ap-southeast-2',
  ]
})

const progressRows = computed(() =>
  regions.value.map((region) => {
    const progress = graph.scanProgress.get(region)
    return {
      region,
      state: progress?.state ?? 'queued',
      ratio: progress?.progress ?? 0,
      step: progress?.step ?? null,
      count: progress?.resourceCount ?? 0,
      error: progress?.error ?? null,
    }
  }),
)

const scanHint = computed(() => {
  if (graph.scanning) {
    const done = progressRows.value.filter((r) => r.state === 'done').length
    return `Read-only · ${done}/${regions.value.length} regions complete`
  }
  return `${regions.value.length} region${regions.value.length === 1 ? '' : 's'} selected`
})

function statusText(row: (typeof progressRows.value)[number]): string {
  if (row.state === 'done') return `done · ${row.count} resources`
  if (row.state === 'error') return row.error ?? 'failed'
  if (row.state === 'scanning') {
    return row.step ? `${row.step} · ${Math.round(row.ratio * 100)}%` : `${Math.round(row.ratio * 100)}%`
  }
  return 'queued'
}

function toggleRegion(region: string): void {
  regionsTouched = true
  regions.value = regions.value.includes(region)
    ? regions.value.filter((r) => r !== region)
    : [...regions.value, region]
}

/**
 * No profile on this machine, in live mode: offer access keys instead of a
 * dead end. Demo mode always has its fixture profiles, so never shows this.
 */
const needsKeys = computed(() => !app.isDemo && app.profiles.length === 0)
const savedAs = ref<AddCredentialsResponse | null>(null)

async function onKeysSaved(result: AddCredentialsResponse): Promise<void> {
  savedAs.value = result
  app.profiles = await api.profiles()
  app.profile = result.profile
}

function start(): void {
  if (graph.scanning || regions.value.length === 0 || !app.profile) return
  graph.selectedRegions = [...regions.value]
  graph.startScan(app.profile, regions.value)
  void app.loadIdentity()
}
</script>

<template>
  <div class="ca-dotgrid flex flex-1 items-center justify-center overflow-y-auto p-6">
    <div
      class="ca-panel-shadow w-[520px] max-w-full overflow-hidden rounded-[12px] border border-border2 bg-panel"
    >
      <div class="border-b border-border px-[22px] pb-4 pt-5">
        <div class="mb-1 text-[16px] font-semibold">
          {{ needsKeys ? 'Add AWS access keys' : 'Connect AWS profile' }}
        </div>
        <p class="text-[12.5px] leading-[1.5] text-muted">
          CloudAtlas reads profiles from
          <span class="font-mono text-[11.5px] text-text">~/.aws/config</span> and
          <span class="font-mono text-[11.5px] text-text">~/.aws/credentials</span>. Scanning is
          read-only.
        </p>
      </div>

      <div v-if="needsKeys" class="px-[22px] py-[18px]">
        <AccessKeyForm :regions="availableRegions" @saved="onKeysSaved" />
      </div>

      <div v-else class="flex flex-col gap-[14px] px-[22px] py-[18px]">
        <p
          v-if="savedAs"
          class="rounded-[7px] border border-border bg-panel2 px-[10px] py-[8px] text-[11.5px] leading-[1.5] text-muted"
        >
          <span class="text-ok">✓</span> Keys verified for account
          <span class="font-mono text-text">{{ savedAs.identity.accountId }}</span> and saved as profile
          <span class="font-mono text-text">{{ savedAs.profile }}</span>. Pick regions and start the scan.
        </p>
        <div>
          <div class="mb-[6px] text-[11px] font-semibold text-muted">Profile</div>
          <button
            type="button"
            class="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[7px] border border-border2 bg-panel2 px-[10px] font-mono text-[12px]"
            @click="profilesOpen = !profilesOpen"
          >
            <span>{{ app.profile || 'No profile found' }}</span>
            <span class="ml-auto text-[10px] text-faint">▾</span>
          </button>
          <div
            v-if="profilesOpen"
            class="mt-1 rounded-[8px] border border-border2 bg-panel p-[5px]"
          >
            <button
              v-for="candidate in app.profiles"
              :key="candidate.name"
              type="button"
              class="flex w-full cursor-pointer items-center rounded-[5px] px-2 py-[6px] font-mono text-[12px] hover:bg-raise"
              @click="
                () => {
                  app.profile = candidate.name
                  profilesOpen = false
                }
              "
            >
              <span>{{ candidate.name }}</span>
              <span class="ml-auto text-[11px] text-faint">{{
                candidate.sso ? 'SSO' : candidate.region || ''
              }}</span>
            </button>
            <p v-if="app.profiles.length === 0" class="px-2 py-2 text-[11.5px] text-muted">
              No profiles found. Run <span class="font-mono">aws configure</span> or
              <span class="font-mono">aws sso login</span>, then press Reconnect.
            </p>
          </div>
        </div>

        <div>
          <div class="mb-[6px] text-[11px] font-semibold text-muted">Regions</div>
          <div class="flex max-h-[104px] flex-wrap gap-[6px] overflow-y-auto">
            <button
              v-for="region in availableRegions"
              :key="region"
              type="button"
              class="flex cursor-pointer items-center gap-[6px] rounded-[6px] border px-2 py-[4px] font-mono text-[11.5px] transition-colors"
              :class="
                regions.includes(region)
                  ? 'border-border2 bg-raise text-text'
                  : 'border-border bg-panel2 text-muted hover:text-text'
              "
              @click="toggleRegion(region)"
            >
              <CaCheckbox :checked="regions.includes(region)" />
              {{ region }}
            </button>
          </div>
        </div>

        <div class="flex gap-[9px] rounded-[8px] border border-border bg-panel2 px-3 py-[11px]">
          <span class="text-[12px] leading-[1.5] text-warn">◆</span>
          <p class="text-[12px] leading-[1.55] text-muted">
            Attach the managed policy
            <span class="font-mono text-[11.5px] text-text">ReadOnlyAccess</span>, or the scoped
            CloudAtlas read-only policy in
            <span class="font-mono text-[11.5px] text-text">docs/iam-policy.json</span>. Write
            permissions are never used.
          </p>
        </div>

        <div v-if="graph.scanning || graph.lastScanAt" class="flex flex-col gap-[9px] pt-[2px]">
          <div v-for="row in progressRows" :key="row.region">
            <div class="mb-[5px] flex items-center">
              <span class="font-mono text-[11.5px]">{{ row.region }}</span>
              <span
                class="ml-auto text-[11px]"
                :class="row.state === 'error' ? 'text-bad' : 'text-muted'"
                >{{ statusText(row) }}</span
              >
            </div>
            <div class="h-[4px] overflow-hidden rounded-[3px] bg-raise">
              <div
                class="h-full transition-[width] duration-150"
                :style="{
                  width: `${Math.round(row.ratio * 100)}%`,
                  background:
                    row.state === 'error'
                      ? 'var(--ca-bad)'
                      : row.state === 'done'
                        ? 'var(--ca-ok)'
                        : 'var(--ca-text)',
                }"
              />
            </div>
          </div>
        </div>

        <p
          v-if="graph.scanError"
          class="rounded-[8px] border px-3 py-[10px] text-[12px] leading-[1.5] text-bad"
          style="border-color: rgba(242, 85, 90, 0.45)"
        >
          {{ graph.scanError }}
        </p>

        <div class="flex items-center gap-[10px] pt-[2px]">
          <CaButton
            variant="primary"
            :disabled="graph.scanning || regions.length === 0 || !app.profile"
            @click="start"
          >
            {{ graph.scanning ? 'Scanning…' : 'Scan environment' }}
          </CaButton>
          <span class="text-[12px] text-faint">{{ scanHint }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
