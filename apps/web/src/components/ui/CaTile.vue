<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { NodeType } from '@cloudatlas/shared'
import { AWS_ICONS } from '@/lib/aws-icons.generated'

const props = withDefaults(
  defineProps<{
    abbr: string
    color: string
    /** Resource kind; selects the official AWS icon when one is mapped. */
    nodeType?: NodeType
    /** Square edge length in px. */
    size?: number
    radius?: number
    dimmed?: boolean
    /** Colour of the focus/alert ring, or null for the default drop shadow. */
    ring?: string | null
    pulse?: boolean
  }>(),
  { size: 44, radius: 9, dimmed: false, ring: null, pulse: false },
)

/**
 * Set when the SVG fails to load — the icons are optional assets, so a missing
 * or corrupt file degrades to the abbreviation tile rather than a broken image.
 */
const loadFailed = ref(false)
watch(
  () => props.nodeType,
  () => {
    loadFailed.value = false
  },
)

const icon = computed(() => {
  if (loadFailed.value || !props.nodeType) return null
  return AWS_ICONS[props.nodeType] ?? null
})

const shadow = computed(() =>
  props.ring
    ? `0 0 0 2px var(--ca-canvas), 0 0 0 4px ${props.ring}`
    : '0 1px 2px rgba(0,0,0,.35)',
)

const style = computed(() => {
  const base: Record<string, string | undefined> = {
    width: `${props.size}px`,
    height: `${props.size}px`,
    borderRadius: `${props.radius}px`,
    boxShadow: shadow.value,
    // Stopped resources grey out; this reads on the coloured AWS tiles too.
    filter: props.dimmed ? 'grayscale(1)' : undefined,
    opacity: props.dimmed ? '0.65' : undefined,
    animation: props.pulse ? 'ca-pulse 2s ease-out infinite' : undefined,
  }

  const current = icon.value
  if (!current) return { ...base, background: props.color }

  // Service icons ship their own filled background. Resource icons are line
  // art, so they sit on a panel tile outlined in the category colour — the
  // convention AWS's own architecture diagrams use.
  return current.style === 'service'
    ? { ...base, background: 'transparent' }
    : { ...base, background: 'var(--ca-panel)', border: `1.5px solid ${props.color}` }
})

const imageInset = computed(() => (icon.value?.style === 'resource' ? '18%' : '0'))
</script>

<template>
  <span
    class="relative flex shrink-0 items-center justify-center overflow-hidden font-mono font-medium text-white"
    :style="style"
  >
    <img
      v-if="icon"
      :src="icon.src"
      :alt="abbr"
      class="pointer-events-none block h-full w-full select-none"
      :style="{ padding: imageInset }"
      draggable="false"
      @error="loadFailed = true"
    />
    <template v-else>
      <span :style="{ fontSize: `${Math.max(8, Math.round(size * 0.25))}px` }">{{ abbr }}</span>
    </template>
  </span>
</template>
