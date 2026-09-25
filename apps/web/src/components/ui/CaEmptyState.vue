<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
    tone?: 'neutral' | 'error' | 'pending'
    glyph?: string
  }>(),
  { tone: 'neutral', glyph: '◇' },
)
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-[10px] px-6 py-10 text-center">
    <span
      class="flex h-9 w-9 items-center justify-center rounded-[10px] border text-[14px]"
      :class="
        tone === 'error'
          ? 'border-bad/50 text-bad'
          : tone === 'pending'
            ? 'border-border2 text-warn'
            : 'border-border2 text-faint'
      "
      >{{ tone === 'error' ? '!' : glyph }}</span
    >
    <div class="text-[13px] font-semibold">{{ title }}</div>
    <div v-if="description" class="max-w-[320px] text-[12px] leading-[1.55] text-muted">
      {{ description }}
    </div>
    <slot />
  </div>
</template>
