<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORY_COLORS } from '@cloudatlas/shared'
import { useAppStore, VIEWS } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { useHealthStore } from '@/stores/health'
import CaCheckbox from './ui/CaCheckbox.vue'
import CaToggle from './ui/CaToggle.vue'

const app = useAppStore()
const graph = useGraphStore()
const health = useHealthStore()

const width = computed(() => (app.sidebarOpen ? '236px' : '46px'))

/** Views get a badge when they have something waiting, like open findings. */
function badgeFor(viewId: string): number | null {
  if (viewId !== 'health') return null
  const total = health.criticalCount + health.warningCount
  return total > 0 ? total : null
}
</script>

<template>
  <nav
    class="flex shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-150"
    :style="{ width, flexBasis: width }"
  >
    <div class="flex items-center justify-between py-[10px] pl-3 pr-[10px]">
      <div v-if="app.sidebarOpen" class="ca-eyebrow">Views</div>
      <button
        type="button"
        class="h-[22px] w-[22px] cursor-pointer rounded-[5px] border border-border bg-transparent text-[11px] leading-none text-muted hover:text-text"
        :title="app.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'"
        @click="app.sidebarOpen = !app.sidebarOpen"
      >
        {{ app.sidebarOpen ? '‹' : '›' }}
      </button>
    </div>

    <div class="flex flex-col gap-[2px] px-2">
      <button
        v-for="item in VIEWS"
        :key="item.id"
        type="button"
        class="flex h-[30px] cursor-pointer items-center gap-[9px] rounded-[7px] px-[9px] text-[12.5px] transition-colors"
        :class="
          app.view === item.id
            ? 'bg-raise font-semibold text-text'
            : 'font-normal text-muted hover:bg-raise/60'
        "
        :title="item.label"
        @click="app.setView(item.id)"
      >
        <span
          class="h-[5px] w-[5px] shrink-0 rounded-full"
          :style="{ background: app.view === item.id ? '#ED7100' : 'var(--ca-border2)' }"
        />
        <template v-if="app.sidebarOpen">
          <span>{{ item.label }}</span>
          <span
            v-if="badgeFor(item.id)"
            class="ml-auto rounded-full bg-bad px-[6px] py-[1px] text-[9.5px] font-bold text-white"
            >{{ badgeFor(item.id) }}</span
          >
        </template>
      </button>
    </div>

    <div
      v-if="app.sidebarOpen"
      class="flex flex-1 flex-col gap-[18px] overflow-y-auto px-3 py-4"
    >
      <section>
        <div class="ca-eyebrow mb-2">Service type</div>
        <div class="flex flex-col gap-px">
          <button
            v-for="item in graph.categoryCounts"
            :key="item.id"
            type="button"
            class="flex cursor-pointer items-center gap-2 rounded-[6px] px-[6px] py-[5px] text-left hover:bg-raise"
            @click="graph.toggleCategory(item.id)"
          >
            <CaCheckbox :checked="graph.categories.includes(item.id)" />
            <span
              class="h-2 w-2 shrink-0 rounded-[2px]"
              :style="{ background: CATEGORY_COLORS[item.id] }"
            />
            <span class="text-[12.5px] text-text">{{ item.label }}</span>
            <span class="ml-auto font-mono text-[11px] text-faint">{{ item.count }}</span>
          </button>
        </div>
      </section>

      <!-- A VPC filter is how you read one network at a time in an account
           that has several; without it every VPC competes for the canvas. -->
      <section v-if="graph.vpcs.length > 1">
        <div class="mb-2 flex items-center gap-2">
          <span class="ca-eyebrow">VPC</span>
          <button
            v-if="graph.vpcFilter.length > 0"
            type="button"
            class="ml-auto cursor-pointer text-[11px] text-faint hover:text-text"
            @click="graph.vpcFilter = []"
          >
            Show all
          </button>
        </div>
        <div class="flex flex-col gap-px">
          <button
            v-for="vpc in graph.vpcs"
            :key="vpc.id"
            type="button"
            class="flex cursor-pointer items-center gap-2 rounded-[6px] px-[6px] py-[5px] text-left hover:bg-raise"
            :title="`${vpc.name}${vpc.cidr ? ` · ${vpc.cidr}` : ''} · ${vpc.region}`"
            @click="graph.toggleVpc(vpc.id)"
          >
            <!-- Nothing selected means everything is shown, so every box reads
                 as checked rather than as an empty filter nobody set. -->
            <CaCheckbox
              :checked="graph.vpcFilter.length === 0 || graph.vpcFilter.includes(vpc.id)"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] text-text">{{
                graph.displayName(vpc)
              }}</span>
              <span v-if="vpc.cidr" class="block truncate font-mono text-[10.5px] text-faint">{{
                vpc.cidr
              }}</span>
            </span>
            <span class="ml-auto shrink-0 font-mono text-[11px] text-faint">{{ vpc.count }}</span>
          </button>
        </div>
      </section>

      <section>
        <div class="ca-eyebrow mb-2">Tag filter</div>
        <div class="flex gap-[6px]">
          <input
            v-model="graph.tagKeyFilter"
            class="h-[28px] w-full min-w-0 flex-1 rounded-[6px] border border-border bg-panel2 px-2 font-mono text-[11px] text-text outline-none placeholder:text-muted focus:border-border2"
            placeholder="Service"
            aria-label="Tag key"
          />
          <input
            v-model="graph.tagValueFilter"
            class="h-[28px] w-full min-w-0 flex-1 rounded-[6px] border border-border bg-panel2 px-2 font-mono text-[11px] text-text outline-none placeholder:text-muted focus:border-border2"
            placeholder="any value"
            aria-label="Tag value"
          />
        </div>
      </section>

      <section v-if="graph.environments.length > 0">
        <div class="ca-eyebrow mb-2">Environment</div>
        <div class="flex flex-wrap gap-[6px]">
          <button
            v-for="env in graph.environments"
            :key="env"
            type="button"
            class="cursor-pointer rounded-full border px-[9px] py-[3px] font-mono text-[11.5px] transition-colors"
            :class="
              graph.envFilter.includes(env)
                ? 'border-text bg-text text-bg'
                : 'border-border2 bg-transparent text-muted hover:text-text'
            "
            @click="graph.toggleEnv(env)"
          >
            {{ env }}
          </button>
        </div>
      </section>

      <CaToggle v-model="graph.hideUnconnected" label="Hide unconnected resources" />
    </div>
  </nav>
</template>
