<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { isContainerType, type SimulationScope } from '@cloudatlas/shared'
import { useGraphStore } from '@/stores/graph'
import { useSimulationStore } from '@/stores/simulation'
import { relativeTime } from '@/lib/utils'
import CaEmptyState from '../ui/CaEmptyState.vue'
import SimulationEditor from '../simulation/SimulationEditor.vue'

/**
 * Simulations: a frozen copy of the scanned environment to design against.
 * Add, connect, edit and remove resources; see what it does to cost,
 * compliance and exposure; export it as Terraform or AWS CLI to build it.
 * Nothing here changes AWS.
 */

const graph = useGraphStore()
const sim = useSimulationStore()

const newName = ref('')
const confirmDelete = ref<string | null>(null)

onMounted(() => void sim.loadList())

// --- scope: which VPCs to clone -------------------------------------------
const resources = computed(() =>
  (graph.graph?.nodes ?? []).filter((node) => !isContainerType(node.type) && node.type !== 'internet'),
)
const vpcs = computed(() =>
  (graph.graph?.nodes ?? [])
    .filter((node) => node.type === 'vpc')
    .map((vpc) => ({ vpc, count: resources.value.filter((node) => node.vpcId === vpc.id).length }))
    .sort((a, b) => a.vpc.region.localeCompare(b.vpc.region) || b.count - a.count),
)
const outsideCount = computed(() => resources.value.filter((node) => !node.vpcId).length)
const chosen = ref(new Set<string>())
const includeOutside = ref(true)
// Everything is chosen until the user narrows it.
watch(vpcs, (list) => (chosen.value = new Set(list.map((entry) => entry.vpc.id))), { immediate: true })

function toggleVpc(id: string): void {
  const next = new Set(chosen.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  chosen.value = next
}
function only(id: string): void {
  chosen.value = new Set([id])
  includeOutside.value = false
}

const everything = computed(() => chosen.value.size === vpcs.value.length && includeOutside.value)
const scope = computed<SimulationScope | null>(() =>
  everything.value ? null : { vpcIds: [...chosen.value], includeOutside: includeOutside.value },
)
const nothing = computed(() => chosen.value.size === 0 && !includeOutside.value)
const scopeLabel = (value: SimulationScope | null | undefined): string => {
  if (!value) return 'whole account'
  const names = value.vpcIds.map((id) => graph.graph?.nodes.find((node) => node.id === id)?.name ?? id)
  const vpcPart = names.length === 1 ? names[0]! : `${names.length} VPCs`
  return value.includeOutside ? `${vpcPart} + services outside VPCs` : vpcPart
}

async function create(): Promise<void> {
  if (nothing.value) return
  const name = newName.value.trim() || `Simulation ${new Date().toLocaleDateString()}`
  await sim.create(name, scope.value)
  newName.value = ''
}

</script>

<template>
  <!-- ======================= List ======================= -->
  <div v-if="sim.current?.simulation.kind !== 'simulation'" class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-[900px] px-6 py-6">
      <h1 class="text-[20px] font-semibold">Simulations</h1>
      <p class="mt-1 max-w-[720px] text-[12.5px] leading-[1.6] text-muted">
        Clone the scanned environment into a project and design against it: add resources, connect them to what
        exists, change or remove things. CloudAtlas shows what each change does to cost, compliance and internet
        exposure, and exports the result as Terraform or AWS CLI. Nothing here touches AWS.
      </p>

      <form class="mt-5 flex gap-2" @submit.prevent="create">
        <input
          v-model="newName"
          class="h-[34px] min-w-0 flex-1 rounded-[7px] border border-border2 bg-panel2 px-[10px] text-[12.5px] outline-none focus:border-text"
          placeholder="Name, e.g. Checkout service v2"
        />
        <button
          type="submit"
          class="h-[34px] cursor-pointer rounded-[7px] border border-border2 bg-raise px-[14px] text-[12.5px] font-medium hover:border-text disabled:opacity-50"
          :disabled="!graph.graph || nothing"
        >
          {{ everything ? 'Clone whole environment' : 'Clone selection' }}
        </button>
      </form>

      <fieldset v-if="vpcs.length" class="mt-3 rounded-[10px] border border-border bg-panel px-[12px] py-[10px]">
        <legend class="px-[4px] text-[11px] font-semibold text-muted">What to simulate</legend>
        <ul class="flex flex-col">
          <li v-for="entry in vpcs" :key="entry.vpc.id" class="group flex items-center gap-[9px] py-[4px] text-[12px]">
            <input
              :id="`scope-${entry.vpc.id}`"
              type="checkbox"
              class="cursor-pointer"
              :checked="chosen.has(entry.vpc.id)"
              @change="toggleVpc(entry.vpc.id)"
            />
            <label :for="`scope-${entry.vpc.id}`" class="min-w-0 flex-1 cursor-pointer truncate">
              <span class="font-medium">{{ entry.vpc.name }}</span>
              <span class="ml-[6px] font-mono text-[10.5px] text-faint">{{ entry.vpc.cidr }} · {{ entry.vpc.region }}</span>
            </label>
            <span class="text-[11px] text-muted">{{ entry.count }} resource{{ entry.count === 1 ? '' : 's' }}</span>
            <button
              type="button"
              class="cursor-pointer text-[11px] text-faint opacity-0 hover:text-text group-hover:opacity-100 focus:opacity-100"
              @click="only(entry.vpc.id)"
            >
              only this
            </button>
          </li>
          <li class="mt-[4px] flex items-center gap-[9px] border-t border-border pt-[7px] text-[12px]">
            <input id="scope-outside" v-model="includeOutside" type="checkbox" class="cursor-pointer" />
            <label for="scope-outside" class="min-w-0 flex-1 cursor-pointer text-muted">
              Services outside any VPC <span class="text-faint">(buckets, queues, functions…)</span>
            </label>
            <span class="text-[11px] text-muted">{{ outsideCount }}</span>
          </li>
        </ul>
      </fieldset>
      <p class="mt-[6px] text-[11px] text-faint">
        Copies the scan from {{ graph.graph ? relativeTime(graph.graph.scannedAt) : '—' }}. The copy stays as it is;
        refresh it later from inside the simulation.
      </p>
      <p v-if="sim.error" class="mt-3 text-[12px] text-bad">{{ sim.error }}</p>

      <ul class="mt-6 flex flex-col gap-[8px]">
        <li
          v-for="item in sim.list"
          :key="item.id"
          class="flex items-center gap-3 rounded-[10px] border border-border bg-panel px-[14px] py-[11px]"
        >
          <button type="button" class="min-w-0 flex-1 cursor-pointer text-left" @click="sim.open(item.id)">
            <div class="truncate text-[13px] font-semibold hover:underline">{{ item.name }}</div>
            <div class="mt-[2px] text-[11px] text-muted">
              {{ scopeLabel(item.scope) }} · {{ item.changeCount }} change{{ item.changeCount === 1 ? '' : 's' }} · edited {{ relativeTime(item.updatedAt) }} ·
              cloned from the scan of {{ relativeTime(item.baseScannedAt) }}
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
        v-if="!sim.loading && sim.list.length === 0"
        class="mt-4"
        glyph="◇"
        title="No simulations yet"
        description="Clone the environment above to start one."
      />
    </div>
  </div>

  <!-- ======================= Editor ======================= -->
  <SimulationEditor v-else />
</template>
