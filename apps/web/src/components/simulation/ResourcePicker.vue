<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GraphNode } from '@cloudatlas/shared'
import { nodeColor } from '@/lib/utils'
import CaTile from '../ui/CaTile.vue'

/**
 * A searchable resource dropdown. Accounts have hundreds of resources with
 * long, similar names; a native select makes finding one a scroll. Type any
 * part of the name, type, subnet or ID; arrow keys and Enter pick.
 */

const props = defineProps<{
  options: GraphNode[]
  /** Shown first, under their own heading — e.g. what this simulation added. */
  featured?: Set<string>
  placeholder?: string
  /** Every node, to name the subnet each option sits in. Defaults to the options. */
  context?: GraphNode[]
}>()
const model = defineModel<string>({ required: true })

const open = ref(false)
const query = ref('')
const active = ref(0)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const selected = computed(() => props.options.find((option) => option.id === model.value) ?? null)
const subnetName = (node: GraphNode) => (props.context ?? props.options).find((option) => option.id === node.subnetId)?.name ?? null

const matches = computed(() => {
  const terms = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  const found = props.options.filter((node) => {
    const haystack = `${node.name} ${node.typeLabel} ${node.type} ${node.id} ${node.subtitle ?? ''}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
  const featured = found.filter((node) => props.featured?.has(node.id))
  const rest = found
    .filter((node) => !props.featured?.has(node.id))
    .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name))
  return { featured, rest, all: [...featured, ...rest] }
})

watch(query, () => (active.value = 0))

function show(): void {
  open.value = true
  query.value = ''
  active.value = Math.max(0, matches.value.all.findIndex((node) => node.id === model.value))
  void nextTick(() => {
    input.value?.focus()
    scrollActive()
  })
}

function pick(node: GraphNode): void {
  model.value = node.id
  open.value = false
}

function scrollActive(): void {
  list.value?.querySelector(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' })
}

function onKey(event: KeyboardEvent): void {
  const count = matches.value.all.length
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    active.value = count ? (active.value + 1) % count : 0
    void nextTick(scrollActive)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = count ? (active.value - 1 + count) % count : 0
    void nextTick(scrollActive)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const node = matches.value.all[active.value]
    if (node) pick(node)
  } else if (event.key === 'Escape') {
    // Close the dropdown without also deselecting on the canvas.
    event.stopPropagation()
    open.value = false
  }
}

function onOutside(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('pointerdown', onOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))

const indexOf = (node: GraphNode) => matches.value.all.indexOf(node)
</script>

<template>
  <div ref="root" class="relative">
    <button
      v-if="!open"
      type="button"
      class="flex h-[30px] w-full cursor-pointer items-center gap-[7px] rounded-[6px] border border-border2 bg-panel2 px-[8px] text-left text-[11.5px] outline-none hover:border-text focus:border-text"
      @click="show"
      @keydown.down.prevent="show"
    >
      <template v-if="selected">
        <CaTile :abbr="selected.abbr" :color="nodeColor(selected)" :node-type="selected.type" :size="18" :radius="4" />
        <span class="min-w-0 flex-1 truncate text-text" :title="selected.name">{{ selected.name }}</span>
      </template>
      <span v-else class="flex-1 text-faint">{{ placeholder ?? 'Choose a resource…' }}</span>
      <span class="text-[10px] text-faint">▾</span>
    </button>
    <input
      v-else
      ref="input"
      v-model="query"
      class="h-[30px] w-full rounded-[6px] border border-text bg-panel2 px-[8px] text-[11.5px] text-text outline-none"
      placeholder="Search name, type, subnet or ID…"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
      @keydown="onKey"
    />

    <div
      v-if="open"
      ref="list"
      role="listbox"
      class="absolute inset-x-0 top-[34px] z-30 max-h-[300px] overflow-y-auto rounded-[8px] border border-border2 bg-panel py-[4px] shadow-xl"
    >
      <p v-if="matches.all.length === 0" class="px-[10px] py-[8px] text-[11.5px] text-faint">No resource matches “{{ query }}”.</p>
      <template v-for="group in [{ label: 'New in this simulation', items: matches.featured }, { label: matches.featured.length ? 'Existing' : '', items: matches.rest }]" :key="group.label">
        <div v-if="group.items.length && group.label" class="px-[10px] pb-[2px] pt-[6px] text-[9.5px] font-semibold uppercase tracking-[.06em] text-faint">
          {{ group.label }}
        </div>
        <button
          v-for="node in group.items"
          :key="node.id"
          type="button"
          role="option"
          :data-index="indexOf(node)"
          :aria-selected="node.id === model"
          class="flex w-full cursor-pointer items-center gap-[8px] px-[10px] py-[5px] text-left"
          :class="indexOf(node) === active ? 'bg-raise' : ''"
          @mouseenter="active = indexOf(node)"
          @click="pick(node)"
        >
          <CaTile :abbr="node.abbr" :color="nodeColor(node)" :node-type="node.type" :size="20" :radius="5" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[11.5px] text-text" :title="node.name">{{ node.name }}</span>
            <span class="block truncate text-[10px] text-faint">
              {{ node.typeLabel }}{{ subnetName(node) ? ` · ${subnetName(node)}` : '' }}
            </span>
          </span>
          <span v-if="node.id === model" class="text-[11px] text-ok">✓</span>
        </button>
      </template>
    </div>
  </div>
</template>
