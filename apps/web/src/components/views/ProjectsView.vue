<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ProjectTemplateSummary } from '@cloudatlas/shared'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useSimulationStore } from '@/stores/simulation'
import { relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import SimulationEditor from '../simulation/SimulationEditor.vue'

/**
 * Projects: architecture designed from scratch. Start from a blank region or
 * a template, sketch it with the same editor as simulations, and see what it
 * would cost, where it falls short of compliance and what it exposes — then
 * export it to build it. Nothing here touches AWS, and no scan is needed.
 */

const app = useAppStore()
const graph = useGraphStore()
const sim = useSimulationStore()

onMounted(() => void sim.loadProjects())

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ca-central-1', 'sa-east-1']
const regions = computed(() => [...new Set([...(app.info?.defaultRegions ?? []), ...graph.regionOptions.map((region) => region.id), ...REGIONS])])

const name = ref('')
const description = ref('')
const region = ref('')
watch(regions, (list) => { if (!region.value) region.value = list[0] ?? 'us-east-1' }, { immediate: true })
/** null for a blank canvas. */
const templateId = ref<string | null>(null)
const creating = ref(false)

const builtIn = computed(() => sim.templates.filter((template) => template.builtIn))
const saved = computed(() => sim.templates.filter((template) => !template.builtIn))
const chosen = computed(() => sim.templates.find((template) => template.id === templateId.value) ?? null)

async function create(): Promise<void> {
  if (creating.value) return
  creating.value = true
  await sim.createProject({
    name: name.value.trim() || chosen.value?.name || 'Untitled project',
    description: description.value.trim(),
    region: region.value,
    templateId: templateId.value,
  })
  creating.value = false
  if (sim.current) {
    name.value = ''
    description.value = ''
  }
}

async function removeTemplate(id: string): Promise<void> {
  if (templateId.value === id) templateId.value = null
  await sim.deleteTemplate(id)
}

const confirmDelete = ref<string | null>(null)
const templateName = (id: string | null) => (id ? sim.templates.find((template) => template.id === id)?.name ?? 'a template' : null)

const GLYPH: Record<string, string> = {
  vpc: 'VPC', subnet: 'SN', ec2: 'EC2', rds: 'RDS', elasticache: 'EC', alb: 'ALB',
  'nat-gateway': 'NAT', 'ecs-task': 'ECS', lambda: 'λ', s3: 'S3', sqs: 'SQS',
}
const glyphs = (template: ProjectTemplateSummary) => template.types.filter((type) => type !== 'subnet').map((type) => GLYPH[type] ?? type)

const field = 'h-[32px] rounded-[7px] border border-border2 bg-panel2 px-[10px] text-[12.5px] text-text outline-none focus:border-text'
const card = 'flex cursor-pointer flex-col rounded-[10px] border px-[13px] py-[11px] text-left transition-colors'
</script>

<template>
  <div v-if="sim.current?.simulation.kind !== 'project'" class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-[980px] px-6 py-6">
      <h1 class="text-[20px] font-semibold">Projects</h1>
      <p class="mt-1 max-w-[740px] text-[12.5px] leading-[1.6] text-muted">
        Sketch new architecture from scratch. Start from a blank region or a template, drag in what you need and
        connect it; CloudAtlas estimates the monthly cost, checks it against your compliance frameworks and shows
        what would be reachable from the internet. Export it as Terraform or AWS CLI when it is ready to build.
      </p>

      <!-- ---------------------------- New project ---------------------------- -->
      <section class="mt-5 rounded-[12px] border border-border bg-panel p-[16px]">
        <div class="ca-eyebrow mb-3">Start from</div>
        <div class="grid grid-cols-3 gap-[10px]">
          <button
            type="button"
            :class="[card, templateId === null ? 'border-text bg-raise' : 'border-border hover:border-border2']"
            @click="templateId = null"
          >
            <span class="flex h-[26px] items-center gap-[5px]">
              <span class="flex h-[22px] w-[30px] items-center justify-center rounded-[5px] border border-dashed border-border2 text-[13px] text-muted">+</span>
            </span>
            <span class="mt-[8px] text-[12.5px] font-semibold">Blank canvas</span>
            <span class="mt-[3px] text-[11px] leading-[1.45] text-muted">An empty region. Drag in a VPC or a service to begin.</span>
          </button>
          <button
            v-for="template in builtIn"
            :key="template.id"
            type="button"
            :class="[card, templateId === template.id ? 'border-text bg-raise' : 'border-border hover:border-border2']"
            @click="templateId = template.id"
          >
            <span class="flex h-[26px] flex-wrap items-center gap-[4px] overflow-hidden">
              <span
                v-for="glyph in glyphs(template)"
                :key="glyph"
                class="flex h-[20px] min-w-[26px] items-center justify-center rounded-[5px] border border-border2 px-[4px] font-mono text-[8.5px] font-bold"
              >
                {{ glyph }}
              </span>
            </span>
            <span class="mt-[8px] text-[12.5px] font-semibold">{{ template.name }}</span>
            <span class="mt-[3px] line-clamp-3 text-[11px] leading-[1.45] text-muted">{{ template.description }}</span>
            <span class="mt-auto pt-[6px] text-[10.5px] text-faint">{{ template.resourceCount }} resources</span>
          </button>
        </div>

        <template v-if="saved.length">
          <div class="ca-eyebrow mb-2 mt-4">Your templates</div>
          <div class="grid grid-cols-3 gap-[10px]">
            <div
              v-for="template in saved"
              :key="template.id"
              role="button"
              tabindex="0"
              :class="[card, 'group relative', templateId === template.id ? 'border-text bg-raise' : 'border-border hover:border-border2']"
              @click="templateId = template.id"
              @keydown.enter="templateId = template.id"
            >
              <span class="text-[12.5px] font-semibold">{{ template.name }}</span>
              <span v-if="template.description" class="mt-[3px] line-clamp-2 text-[11px] leading-[1.45] text-muted">{{ template.description }}</span>
              <span class="mt-auto pt-[6px] text-[10.5px] text-faint">
                {{ template.resourceCount }} resources · saved {{ relativeTime(template.createdAt) }}
              </span>
              <button
                type="button"
                class="absolute right-[10px] top-[9px] cursor-pointer text-[10.5px] text-faint opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100"
                title="Delete this template"
                @click.stop="removeTemplate(template.id)"
              >
                Delete
              </button>
            </div>
          </div>
        </template>

        <form class="mt-4 flex flex-wrap items-end gap-[8px] border-t border-border pt-4" @submit.prevent="create">
          <label class="flex min-w-[220px] flex-1 flex-col gap-[4px]">
            <span class="text-[10.5px] font-semibold text-muted">Name</span>
            <input v-model="name" :class="field" :placeholder="chosen?.name ?? 'e.g. Payments platform'" maxlength="80" />
          </label>
          <label class="flex min-w-[260px] flex-[2] flex-col gap-[4px]">
            <span class="text-[10.5px] font-semibold text-muted">What is it for? <span class="font-normal text-faint">(optional)</span></span>
            <input v-model="description" :class="field" placeholder="e.g. New checkout service with a queue for receipts" maxlength="500" />
          </label>
          <label class="flex flex-col gap-[4px]">
            <span class="text-[10.5px] font-semibold text-muted">Region</span>
            <select v-model="region" :class="[field, 'font-mono text-[12px]']">
              <option v-for="option in regions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <button
            type="submit"
            class="h-[32px] cursor-pointer rounded-[7px] border border-text bg-raise px-[16px] text-[12.5px] font-semibold text-text hover:bg-panel2 disabled:opacity-50"
            :disabled="creating"
          >
            {{ creating ? 'Creating…' : chosen ? `Create from ${chosen.name}` : 'Create blank project' }}
          </button>
        </form>
        <p v-if="sim.error" class="mt-3 text-[12px] text-bad">{{ sim.error }}</p>
      </section>

      <!-- ---------------------------- Projects ---------------------------- -->
      <div class="ca-eyebrow mb-2 mt-7">Your projects</div>
      <ul class="flex flex-col gap-[8px]">
        <li
          v-for="item in sim.projects"
          :key="item.id"
          class="flex items-center gap-3 rounded-[10px] border border-border bg-panel px-[14px] py-[11px]"
        >
          <button type="button" class="min-w-0 flex-1 cursor-pointer text-left" @click="sim.open(item.id)">
            <div class="truncate text-[13px] font-semibold hover:underline">{{ item.name }}</div>
            <div v-if="item.description" class="mt-[1px] truncate text-[11.5px] text-muted">{{ item.description }}</div>
            <div class="mt-[2px] text-[11px] text-faint">
              <template v-if="templateName(item.templateId)">from {{ templateName(item.templateId) }} · </template>
              {{ item.changeCount }} change{{ item.changeCount === 1 ? '' : 's' }} · edited {{ relativeTime(item.updatedAt) }}
            </div>
          </button>
          <template v-if="confirmDelete === item.id">
            <span class="text-[11.5px] text-muted">Delete?</span>
            <button type="button" class="cursor-pointer text-[11.5px] font-semibold text-bad" @click="sim.destroy(item.id)">Delete</button>
            <button type="button" class="cursor-pointer text-[11.5px] text-muted" @click="confirmDelete = null">Cancel</button>
          </template>
          <button v-else type="button" class="cursor-pointer text-[11.5px] text-faint hover:text-bad" @click="confirmDelete = item.id">
            Delete
          </button>
        </li>
      </ul>
      <CaEmptyState
        v-if="!sim.loading && sim.projects.length === 0"
        class="mt-2"
        glyph="◇"
        title="No projects yet"
        description="Pick a starting point above and create one."
      />
    </div>
  </div>

  <SimulationEditor v-else />
</template>
