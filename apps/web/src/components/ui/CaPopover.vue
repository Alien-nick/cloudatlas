<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

withDefaults(defineProps<{ open: boolean; width?: string; align?: 'left' | 'right' }>(), {
  width: '220px',
  align: 'left',
})
const emit = defineEmits<{ close: [] }>()

const root = ref<HTMLElement | null>(null)

function onDocumentPointerDown(event: PointerEvent): void {
  if (!root.value) return
  if (!root.value.contains(event.target as Node)) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="relative">
    <slot name="trigger" />
    <div
      v-if="open"
      class="ca-panel-shadow absolute top-[36px] z-40 rounded-[9px] border border-border2 bg-panel p-[6px]"
      :class="align === 'right' ? 'right-0' : 'left-0'"
      :style="{ width }"
    >
      <slot name="content" />
    </div>
  </div>
</template>
