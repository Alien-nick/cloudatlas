<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SimulationScope } from '@cloudatlas/shared'
import { useGraphStore } from '@/stores/graph'
import { useSimulationStore } from '@/stores/simulation'
import { relativeTime } from '@/lib/utils'
import AddPalette from './AddPalette.vue'
import ChangeLog from './ChangeLog.vue'
import ExportDialog from './ExportDialog.vue'
import ImpactPanel from './ImpactPanel.vue'
import SelectionPanel from './SelectionPanel.vue'
import SimCanvas from './SimCanvas.vue'

/**
 * The editor shared by simulations and projects: palette and change log on
 * the left, the diagram in the middle, impact on the right. A simulation is
 * a copy of a scan and can be refreshed from a newer one; a project is a
 * design from scratch and can be saved as a template instead.
 */

const graph = useGraphStore()
const sim = useSimulationStore()

const current = computed(() => sim.current!)
const isProject = computed(() => current.value.simulation.kind === 'project')

// --- name and description ---------------------------------------------------
const renaming = ref(false)
const nameDraft = ref('')
function startRename(): void {
  nameDraft.value = current.value.simulation.name
  renaming.value = true
}
async function finishRename(): Promise<void> {
  if (!renaming.value) return
  renaming.value = false
  const next = nameDraft.value.trim()
  if (next && next !== current.value.simulation.name) await sim.rename(next)
}

const describing = ref(false)
const descriptionDraft = ref('')
function startDescribe(): void {
  descriptionDraft.value = current.value.simulation.description
  describing.value = true
}
async function finishDescribe(): Promise<void> {
  if (!describing.value) return
  describing.value = false
  if (descriptionDraft.value !== current.value.simulation.description) await sim.describe(descriptionDraft.value.trim())
}

// --- subtitle -----------------------------------------------------------------
const scopeLabel = (value: SimulationScope | null | undefined): string => {
  if (!value) return 'whole account'
  const names = value.vpcIds.map((id) => graph.graph?.nodes.find((node) => node.id === id)?.name ?? id)
  const vpcPart = names.length === 1 ? names[0]! : `${names.length} VPCs`
  return value.includeOutside ? `${vpcPart} + services outside VPCs` : vpcPart
}
const regions = computed(() => [...new Set(current.value.graph.nodes.filter((node) => node.type === 'region').map((node) => node.region))])

// --- save as template --------------------------------------------------------
const templating = ref(false)
const templateName = ref('')
const templateDescription = ref('')
const templateSaved = ref<string | null>(null)
function startTemplate(): void {
  templateName.value = current.value.simulation.name
  templateDescription.value = current.value.simulation.description
  templateSaved.value = null
  templating.value = true
}
async function saveTemplate(): Promise<void> {
  const saved = await sim.saveAsTemplate(templateName.value.trim(), templateDescription.value.trim())
  if (saved) {
    templateSaved.value = saved.name
    templating.value = false
  }
}

const exporting = ref<'cli' | 'terraform' | null>(null)

const headerButton =
  'h-[26px] cursor-pointer rounded-[6px] border border-border2 bg-panel2 px-[10px] text-[11.5px] text-muted hover:text-text'
const field = 'w-full rounded-[6px] border border-border2 bg-panel2 px-[8px] text-[12px] text-text outline-none focus:border-text'
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[40px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <button type="button" class="cursor-pointer text-[12px] text-muted hover:text-text" @click="sim.close()">
        ‹ {{ isProject ? 'Projects' : 'Simulations' }}
      </button>
      <input
        v-if="renaming"
        v-model="nameDraft"
        class="h-[26px] w-[260px] rounded-[6px] border border-border2 bg-panel2 px-[8px] text-[12.5px] outline-none"
        autofocus
        @keydown.enter="finishRename"
        @keydown.esc="renaming = false"
        @blur="finishRename"
      />
      <button v-else type="button" class="cursor-text text-[13px] font-semibold" title="Rename" @click="startRename">
        {{ current.simulation.name }}
      </button>

      <span v-if="isProject" class="text-[11px] text-faint">project · {{ regions.join(', ') }}</span>
      <span v-else class="text-[11px] text-faint">
        {{ scopeLabel(current.simulation.scope) }} · cloned from the scan of
        {{ relativeTime(current.simulation.baseScannedAt) }}
      </span>

      <template v-if="isProject">
        <input
          v-if="describing"
          v-model="descriptionDraft"
          class="h-[26px] min-w-0 flex-1 rounded-[6px] border border-border2 bg-panel2 px-[8px] text-[11.5px] outline-none"
          placeholder="What is this project for?"
          maxlength="500"
          autofocus
          @keydown.enter="finishDescribe"
          @keydown.esc="describing = false"
          @blur="finishDescribe"
        />
        <button
          v-else
          type="button"
          class="min-w-0 flex-1 cursor-text truncate text-left text-[11.5px]"
          :class="current.simulation.description ? 'text-muted' : 'text-faint italic'"
          :title="current.simulation.description || 'Add a description'"
          @click="startDescribe"
        >
          {{ current.simulation.description || 'Add a description…' }}
        </button>
      </template>

      <div class="ml-auto flex shrink-0 gap-[6px]">
        <span v-if="templateSaved" class="self-center text-[11px] text-ok">Saved “{{ templateSaved }}” as a template</span>
        <button
          v-if="isProject"
          type="button"
          :class="headerButton"
          title="Reuse this design as a starting point for new projects"
          @click="startTemplate"
        >
          Save as template
        </button>
        <button
          v-else
          type="button"
          :class="headerButton"
          title="Replace the copy with the latest scan, keeping every change"
          @click="sim.rebase()"
        >
          Refresh from latest scan
        </button>
        <button type="button" :class="headerButton" @click="exporting = 'cli'">AWS CLI</button>
        <button type="button" :class="headerButton" @click="exporting = 'terraform'">Terraform</button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <aside class="w-[300px] shrink-0 overflow-y-auto border-r border-border bg-panel px-[14px] py-[12px]">
        <SelectionPanel v-if="sim.selected" :key="sim.selected.id" />
        <template v-else>
          <section class="mb-5">
            <div class="ca-eyebrow mb-2">Add</div>
            <AddPalette />
            <p class="mt-[7px] text-[10.5px] leading-[1.45] text-faint">
              Drag onto a subnet, VPC or region on the diagram. Or click a subnet or VPC first, then add inside it.
              Settings can be changed once it is placed.
            </p>
          </section>
          <ChangeLog />
        </template>
        <p v-if="sim.error" class="mt-3 text-[11.5px] text-bad">{{ sim.error }}</p>
      </aside>

      <SimCanvas :key="current.simulation.id" />

      <aside class="w-[340px] shrink-0 overflow-y-auto border-l border-border bg-panel px-[14px] py-[12px]">
        <ImpactPanel />
      </aside>
    </div>

    <ExportDialog
      v-if="exporting"
      :simulation-id="current.simulation.id"
      :name="current.simulation.name"
      :format="exporting"
      @close="exporting = null"
    />

    <div
      v-if="templating"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="templating = false"
      @keydown.esc="templating = false"
    >
      <form class="w-[420px] rounded-[12px] border border-border2 bg-panel p-[18px] shadow-2xl" @submit.prevent="saveTemplate">
        <h2 class="text-[14px] font-semibold">Save as template</h2>
        <p class="mt-1 text-[11.5px] leading-[1.5] text-muted">
          New projects can start from this design — its resources, settings and connections, placed in whichever
          region the new project uses.
        </p>
        <label class="mt-4 flex flex-col gap-[4px]">
          <span class="text-[10.5px] font-semibold text-muted">Name</span>
          <input v-model="templateName" :class="[field, 'h-[30px]']" maxlength="80" required autofocus />
        </label>
        <label class="mt-3 flex flex-col gap-[4px]">
          <span class="text-[10.5px] font-semibold text-muted">Description</span>
          <textarea v-model="templateDescription" :class="[field, 'min-h-[64px] py-[6px]']" maxlength="500" />
        </label>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" :class="headerButton" @click="templating = false">Cancel</button>
          <button
            type="submit"
            class="h-[26px] cursor-pointer rounded-[6px] border border-text bg-raise px-[12px] text-[11.5px] font-semibold text-text disabled:opacity-50"
            :disabled="!templateName.trim()"
          >
            Save template
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
