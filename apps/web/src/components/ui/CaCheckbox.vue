<script setup lang="ts">
defineProps<{ checked: boolean }>()
</script>

<template>
  <span
    class="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3.5px] border text-[8.5px] leading-none transition-colors"
    :class="checked ? 'border-text bg-text text-bg' : 'border-border2 bg-transparent text-transparent'"
    aria-hidden="true"
  >
    ✓
  </span>
</template>
