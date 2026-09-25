<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useAppStore, VIEWS, type ViewId } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'
import { nodeColor } from '@/lib/utils'
import { rankResources } from '@/lib/palette'

/**
 * ⌘K palette: jump to a resource, switch view, toggle a setting.
 *
 * Resources are ranked rather than merely filtered. With a few hundred nodes,
 * substring matching alone buries the exact name you typed under every node
 * that happens to contain it, so an exact match sorts first, then a prefix,
 * then a name match, then anything else. Typing a full resource name and
 * finding it third is the failure that makes a palette useless.
 */

const app = useAppStore()
const graph = useGraphStore()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)

interface Command {
  id: string
  label: string
  hint: string
  /** Colour dot, for resources. */
  color?: string
  run: () => void
}

const resourceCommands = computed<Command[]>(() =>
  rankResources(graph.graph?.nodes ?? [], query.value).map((node) => ({
    id: `node:${node.id}`,
    label: node.name,
    hint: `${node.typeLabel} · ${node.region}${node.health === 'critical' ? ' · critical' : ''}`,
    color: nodeColor(node),
    run: () => {
      app.setView('topology')
      graph.select(node.id)
      app.panelOpen = true
    },
  })),
)

const actionCommands = computed<Command[]>(() => {
  const actions: Command[] = [
    ...VIEWS.map((view) => ({
      id: `view:${view.id}`,
      label: `Go to ${view.label}`,
      hint: 'View',
      run: () => app.setView(view.id as ViewId),
    })),
    {
      id: 'action:theme',
      label: app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      hint: 'Appearance',
      run: () => app.toggleTheme(),
    },
    {
      id: 'action:agent',
      label: app.agentOpen ? 'Close Ask Claude' : 'Ask Claude about this account',
      hint: 'Agent',
      run: () => {
        app.agentOpen = !app.agentOpen
      },
    },
    {
      id: 'action:panel',
      label: app.panelOpen ? 'Hide the detail panel' : 'Show the detail panel',
      hint: 'Layout',
      run: () => {
        app.panelOpen = !app.panelOpen
      },
    },
  ]

  const needle = query.value.trim().toLowerCase()
  if (needle.length === 0) return actions
  return actions.filter((action) => action.label.toLowerCase().includes(needle))
})

const results = computed(() => [...resourceCommands.value, ...actionCommands.value])

watch(query, () => {
  active.value = 0
})

watch(
  () => app.paletteOpen,
  async (open) => {
    if (!open) return
    query.value = ''
    active.value = 0
    await nextTick()
    input.value?.focus()
  },
)

function move(delta: number): void {
  const count = results.value.length
  if (count === 0) return
  // Wraps, so holding the key does not dead-end at either edge.
  active.value = (active.value + delta + count) % count
}

function run(index = active.value): void {
  const command = results.value[index]
  if (!command) return
  command.run()
  app.paletteOpen = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    run()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    app.paletteOpen = false
  }
}

/** Keep the highlighted row in view when arrowing past the fold. */
watch(active, async () => {
  await nextTick()
  document.querySelector('[data-palette-active="true"]')?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div
    v-if="app.paletteOpen"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
    @click.self="app.paletteOpen = false"
  >
    <div
      class="flex max-h-[62vh] w-[min(620px,92vw)] flex-col overflow-hidden rounded-[11px] border border-border2 bg-panel shadow-2xl"
      role="dialog"
      aria-label="Command palette"
    >
      <input
        ref="input"
        v-model="query"
        type="text"
        placeholder="Search resources, or type a command…"
        class="h-[44px] shrink-0 border-b border-border bg-transparent px-[14px] text-[13px] text-text placeholder:text-faint focus:outline-none"
        @keydown="onKeydown"
      />

      <div v-if="results.length === 0" class="px-[14px] py-[14px] text-[11.5px] text-faint">
        Nothing matches “{{ query }}”.
      </div>

      <div v-else class="min-h-0 flex-1 overflow-y-auto py-[5px]">
        <button
          v-for="(command, index) in results"
          :key="command.id"
          type="button"
          :data-palette-active="index === active"
          class="flex w-full cursor-pointer items-center gap-[9px] px-[14px] py-[6px] text-left transition-colors"
          :class="index === active ? 'bg-raise' : 'hover:bg-panel2'"
          @click="run(index)"
          @mousemove="active = index"
        >
          <span
            v-if="command.color"
            class="h-[7px] w-[7px] shrink-0 rounded-[2px]"
            :style="{ background: command.color }"
          />
          <span v-else class="h-[7px] w-[7px] shrink-0 rounded-full border border-border2" />
          <span class="min-w-0 flex-1 truncate text-[12px] text-text">{{ command.label }}</span>
          <span class="shrink-0 text-[10.5px] text-faint">{{ command.hint }}</span>
        </button>
      </div>

      <div
        class="flex shrink-0 items-center gap-3 border-t border-border px-[14px] py-[6px] text-[10.5px] text-faint"
      >
        <span>↑↓ navigate</span>
        <span>⏎ open</span>
        <span>esc close</span>
        <span class="ml-auto">{{ results.length }} result{{ results.length === 1 ? '' : 's' }}</span>
      </div>
    </div>
  </div>
</template>
