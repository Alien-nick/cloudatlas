<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { catalogEntry, isContainerType, type SettingValue } from '@cloudatlas/shared'
import { useSimulationStore } from '@/stores/simulation'
import { nodeColor } from '@/lib/utils'
import { defaultPort } from '@/lib/simPlacement'
import CaTile from '../ui/CaTile.vue'
import AddPalette from './AddPalette.vue'
import ResourcePicker from './ResourcePicker.vue'
import SettingsForm from './SettingsForm.vue'

/** The selected resource: edit it, connect it, or take it out. */

const sim = useSimulationStore()
const node = computed(() => sim.selected!)
const status = computed(() => sim.current?.status[node.value.id] ?? null)
const entry = computed(() => catalogEntry(node.value.type))
/** VPCs and subnets are places to add things; they are not connected to. */
const isNetwork = computed(() => node.value.type === 'vpc' || node.value.type === 'subnet')

// --- settings --------------------------------------------------------------
const draft = ref<Record<string, SettingValue>>({})
const original = computed(() => sim.current?.settings[node.value.id] ?? null)
watch(original, (next) => (draft.value = { ...(next ?? {}) }), { immediate: true })
const changedKeys = computed(() =>
  Object.keys(draft.value).filter((key) => original.value && draft.value[key] !== original.value[key]),
)
async function saveSettings(): Promise<void> {
  if (changedKeys.value.length === 0) return
  // Only what changed, so the change log reads as the edit that was made.
  await sim.update(node.value.id, Object.fromEntries(changedKeys.value.map((key) => [key, draft.value[key]!])))
}

// --- connections ----------------------------------------------------------
const targets = computed(() =>
  (sim.current?.graph.nodes ?? []).filter(
    (candidate) => candidate.id !== node.value.id && !isContainerType(candidate.type) && candidate.type !== 'internet',
  ),
)
const targetId = ref('')
const addedIds = computed(
  () => new Set(Object.entries(sim.current?.status ?? {}).filter(([, status]) => status === 'added').map(([id]) => id)),
)
const port = ref<number | null>(null)

function portFor(id: string): number | null {
  return defaultPort(targets.value.find((candidate) => candidate.id === id), sim.current?.settings[id])
}
watch(targetId, (id) => (port.value = portFor(id)))
watch(node, () => (targetId.value = ''))

async function connect(): Promise<void> {
  if (!targetId.value) return
  await sim.connect(node.value.id, targetId.value, port.value)
  targetId.value = ''
}

const links = computed(() =>
  (sim.current?.graph.edges ?? [])
    .filter((edge) => (edge.source === node.value.id || edge.target === node.value.id) && edge.kind !== 'risk')
    .map((edge) => {
      const other = edge.source === node.value.id ? edge.target : edge.source
      return {
        edge,
        direction: edge.source === node.value.id ? '→' : '←',
        other: sim.current?.graph.nodes.find((candidate) => candidate.id === other)?.name ?? other,
        simulated: edge.meta.via === 'simulated connection',
      }
    }),
)

const confirmRemove = ref(false)
watch(node, () => (confirmRemove.value = false))

const input = 'h-[28px] w-full rounded-[6px] border border-border2 bg-panel2 px-[8px] font-mono text-[11.5px] text-text outline-none'
const button =
  'h-[28px] cursor-pointer rounded-[6px] border border-border2 bg-raise px-[10px] text-[11.5px] text-text hover:border-text disabled:cursor-not-allowed disabled:opacity-50'
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start gap-[10px]">
      <CaTile :abbr="node.abbr" :color="nodeColor(node)" :node-type="node.type" :size="30" :radius="7" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13px] font-semibold">{{ node.name }}</div>
        <div class="text-[11px] text-muted">
          {{ node.typeLabel }} ·
          <span :class="status === 'added' ? 'text-ok' : status === 'changed' ? 'text-warn' : 'text-faint'">
            {{ status === 'added' ? 'new in this simulation' : status === 'changed' ? 'edited' : 'as scanned' }}
          </span>
        </div>
      </div>
      <button type="button" class="cursor-pointer text-[13px] text-faint hover:text-text" title="Close" @click="sim.selectedId = null">✕</button>
    </div>

    <section v-if="isNetwork">
      <div class="ca-eyebrow mb-2">Add inside {{ node.name }}</div>
      <AddPalette :target-id="node.id" />
      <p class="mt-[6px] text-[10.5px] leading-[1.4] text-faint">
        Click to add with defaults{{ node.type === 'vpc' ? ' — placed in a public or private subnet as suits it' : '' }}.
      </p>
    </section>

    <section v-if="!isNetwork">
      <div class="ca-eyebrow mb-2">Connect to</div>
      <div class="flex flex-col gap-[6px]">
        <ResourcePicker
          v-model="targetId"
          :options="targets"
          :featured="addedIds"
          :context="sim.current?.graph.nodes"
        />
        <div class="flex gap-[6px]">
          <input
            :value="port ?? ''"
            :class="input"
            type="number"
            placeholder="port, or empty for service access"
            @input="port = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null"
          />
          <button type="button" :class="button" :disabled="!targetId" @click="connect">Connect</button>
        </div>
        <p class="text-[10.5px] leading-[1.4] text-faint">
          A port adds a rule to the target's security group. Leave it empty for S3, SQS or Lambda, which are reached through IAM.
        </p>
      </div>
    </section>

    <section v-if="entry && original">
      <div class="ca-eyebrow mb-2">Settings</div>
      <SettingsForm v-model="draft" :fields="entry.fields" />
      <button type="button" :class="[button, 'mt-[10px] w-full']" :disabled="changedKeys.length === 0" @click="saveSettings">
        {{ changedKeys.length ? `Apply ${changedKeys.length} change${changedKeys.length === 1 ? '' : 's'}` : 'No changes' }}
      </button>
    </section>
    <p v-else class="text-[11.5px] text-muted">
      The simulator cannot edit a {{ node.typeLabel }}'s settings, but it can connect it or remove it.
    </p>

    <section v-if="links.length">
      <div class="ca-eyebrow mb-2">Links</div>
      <ul class="flex flex-col gap-[4px]">
        <li v-for="link in links" :key="link.edge.id" class="flex items-center gap-2 text-[11.5px]">
          <span class="text-faint">{{ link.direction }}</span>
          <span class="min-w-0 flex-1 truncate" :title="link.other">{{ link.other }}</span>
          <span class="font-mono text-[10.5px] text-faint">{{ link.edge.label ?? link.edge.kind }}</span>
          <button
            v-if="link.simulated"
            type="button"
            class="cursor-pointer text-[10.5px] text-muted hover:text-bad"
            @click="sim.disconnect(String(link.edge.meta.connectionId))"
          >
            remove
          </button>
          <span v-else class="text-[10px] text-faint">existing</span>
        </li>
      </ul>
    </section>

    <section class="border-t border-border pt-[12px]">
      <button
        v-if="!confirmRemove"
        type="button"
        class="cursor-pointer text-[11.5px] text-muted hover:text-bad"
        @click="confirmRemove = true"
      >
        Remove from the simulation…
      </button>
      <div v-else class="flex items-center gap-2 text-[11.5px]">
        <span class="text-muted">Remove {{ node.name }}{{ isContainerType(node.type) ? ' and everything in it' : '' }}?</span>
        <button type="button" class="cursor-pointer font-semibold text-bad" @click="sim.remove(node.id)">Remove</button>
        <button type="button" class="cursor-pointer text-muted" @click="confirmRemove = false">Cancel</button>
      </div>
    </section>
  </div>
</template>
