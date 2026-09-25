<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CollectorFailure, MissingPermission } from '@cloudatlas/shared'

/**
 * The two ways a section can be incomplete, kept visually distinct because they
 * ask different things of the reader.
 *
 * A missing permission is a known, actionable state: here is the action, add it
 * and the data comes back. An unclassified failure is not — it means the call
 * failed and we could not work out why, so the notice says exactly that rather
 * than implying a permissions fix that may not help.
 */
const props = withDefaults(
  defineProps<{
    permissions?: MissingPermission[]
    failures?: CollectorFailure[]
    /** `inline` sits inside a panel; `banner` floats over the canvas. */
    variant?: 'inline' | 'banner'
    /** What is absent as a result, e.g. "Cache nodes". */
    affects?: string
    /** Banner only: let the reader collapse it out of the way. */
    collapsible?: boolean
  }>(),
  { permissions: () => [], failures: () => [], variant: 'inline', collapsible: false },
)

/**
 * Collapsed state, remembered per browser.
 *
 * The notice is deliberately hard to ignore — an incomplete diagram that looks
 * complete is the failure this whole thing exists to prevent. But it must not
 * be *impossible* to get out of the way: a wide notice pinned over the canvas
 * stops you reading the very diagram it is annotating. Collapsed, it still
 * shows the counts, so the warning never disappears entirely.
 */
const STORAGE_KEY = 'cloudatlas:scan-notice-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Private windows and blocked site data both throw here.
    return false
  }
}

const collapsed = ref(props.collapsible && readCollapsed())

watch(collapsed, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Not remembering the choice is survivable; failing to render is not.
  }
})

const hasAny = computed(() => props.permissions.length > 0 || props.failures.length > 0)

/** One row per distinct action, not per region. */
const actions = computed(() => {
  const byAction = new Map<string, string[]>()
  for (const permission of props.permissions) {
    const regions = byAction.get(permission.action) ?? []
    if (!regions.includes(permission.region)) regions.push(permission.region)
    byAction.set(permission.action, regions)
  }
  return [...byAction.entries()].map(([action, regions]) => ({ action, regions }))
})

/**
 * One row per distinct (call, error), with a count and the regions it hit.
 *
 * A real scan produced 27 identical rows, which is both unreadable and
 * misleading — it looks like 27 problems rather than one problem 27 times.
 * The total is still reported in the heading, so nothing is hidden.
 */
const unknowns = computed(() => {
  const byKey = new Map<
    string,
    { call: string; error: string; regions: string[]; count: number }
  >()

  for (const failure of props.failures) {
    const call = `${failure.service}:${failure.operation}`
    const error = failure.errorCode
      ? `${failure.errorName} / ${failure.errorCode}`
      : failure.errorName
    const key = `${call}|${error}`
    const entry = byKey.get(key) ?? { call, error, regions: [], count: 0 }
    entry.count += 1
    if (!entry.regions.includes(failure.region)) entry.regions.push(failure.region)
    byKey.set(key, entry)
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count || a.call.localeCompare(b.call))
})

/** Counts shown while collapsed, so the warning never vanishes entirely. */
const summary = computed(() => {
  const parts: string[] = []
  if (actions.value.length > 0) {
    parts.push(`${actions.value.length} missing permission${actions.value.length === 1 ? '' : 's'}`)
  }
  if (props.failures.length > 0) parts.push(`${props.failures.length} unknown`)
  return parts.join(' · ')
})
</script>

<template>
  <div
    v-if="hasAny"
    class="rounded-[9px] border text-[12px]"
    :class="variant === 'banner' ? 'ca-panel-shadow bg-panel px-3 py-[10px]' : 'bg-panel2 px-[11px] py-[10px]'"
    :style="{
      borderColor: failures.length > 0 ? 'var(--ca-border2)' : 'rgba(210,153,34,.45)',
    }"
    role="status"
  >
    <button
      v-if="collapsible"
      type="button"
      class="flex w-full cursor-pointer items-center gap-[7px] text-left"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span
        class="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold"
        :class="failures.length > 0 && actions.length === 0 ? 'border border-border2 text-muted' : 'text-white'"
        :style="actions.length > 0 ? 'background: var(--ca-warn)' : ''"
        aria-hidden="true"
        >{{ actions.length > 0 ? '!' : '?' }}</span
      >
      <span class="min-w-0 flex-1 truncate font-semibold">Scan incomplete</span>
      <span class="shrink-0 text-[11px] text-faint">{{ summary }}</span>
      <!-- Drawn rather than typed: the triangle glyphs fall back to a dot in
           several of the fonts this ships with. -->
      <svg
        class="shrink-0 text-faint transition-transform"
        :class="collapsed ? '' : 'rotate-90'"
        width="9"
        height="9"
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        <path d="M3 1.5 L7 5 L3 8.5 Z" fill="currentColor" />
      </svg>
    </button>

    <div v-show="!collapsible || !collapsed" :class="collapsible ? 'mt-[10px] border-t border-border pt-[10px]' : ''">
    <!-- Missing permissions: actionable -->
    <div v-if="actions.length > 0" class="flex items-start gap-[9px]">
      <span
        class="mt-[1px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold text-white"
        style="background: var(--ca-warn)"
        aria-hidden="true"
        >!</span
      >
      <div class="min-w-0 flex-1">
        <div class="font-semibold">
          {{ affects ? `${affects} unavailable` : 'Incomplete' }} — missing
          {{ actions.length === 1 ? 'permission' : 'permissions' }}
        </div>
        <ul class="mt-[5px] flex flex-col gap-[3px]">
          <li v-for="entry in actions" :key="entry.action" class="font-mono text-[11px] text-muted">
            {{ entry.action }}
            <span class="text-faint">· {{ entry.regions.join(', ') }}</span>
          </li>
        </ul>
        <p class="mt-[6px] text-[11.5px] leading-[1.5] text-faint">
          Everything else was collected. Add
          {{ actions.length === 1 ? 'this action' : 'these actions' }} to the profile's policy and
          re-scan.
        </p>
      </div>
    </div>

    <!-- Unclassified: explicitly not a diagnosis -->
    <div
      v-if="unknowns.length > 0"
      class="flex items-start gap-[9px]"
      :class="actions.length > 0 ? 'mt-[10px] border-t border-border pt-[10px]' : ''"
    >
      <span
        class="mt-[1px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] border border-border2 text-[10px] font-bold text-muted"
        aria-hidden="true"
        >?</span
      >
      <div class="min-w-0 flex-1">
        <div class="font-semibold">
          {{ failures.length }}
          {{ failures.length === 1 ? 'call' : 'calls' }} failed for an unknown reason
          <span v-if="unknowns.length < failures.length" class="font-normal text-faint">
            · {{ unknowns.length }} distinct
          </span>
        </div>
        <ul class="mt-[5px] flex max-h-[220px] flex-col gap-[3px] overflow-y-auto">
          <li v-for="(entry, index) in unknowns" :key="index" class="font-mono text-[11px] text-muted">
            {{ entry.call }}
            <span class="text-faint">
              · {{ entry.regions.join(', ') }} · {{ entry.error }}
              <template v-if="entry.count > 1">· ×{{ entry.count }}</template>
            </span>
          </li>
        </ul>
        <p class="mt-[6px] text-[11.5px] leading-[1.5] text-faint">
          This is not a permissions problem as far as we can tell — the error did not match
          anything we recognise. The rest of the scan continued.
        </p>
      </div>
    </div>
    </div>
  </div>
</template>
