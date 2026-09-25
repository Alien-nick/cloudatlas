<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'ghost' | 'primary' | 'icon'
    active?: boolean
    disabled?: boolean
    title?: string
    type?: 'button' | 'submit'
  }>(),
  { variant: 'default', active: false, disabled: false, type: 'button' },
)

const classes = computed(() =>
  cn(
    'inline-flex items-center gap-[6px] rounded-[7px] text-[12.5px] transition-colors select-none',
    'disabled:opacity-45 disabled:cursor-not-allowed',
    props.variant === 'icon'
      ? 'h-[30px] w-[30px] justify-center border border-border bg-transparent text-muted hover:text-text hover:border-border2'
      : props.variant === 'ghost'
        ? 'h-[30px] px-[10px] border border-border bg-transparent text-muted hover:text-text hover:border-border2'
        : props.variant === 'primary'
          ? 'h-[34px] px-4 bg-text text-bg font-semibold hover:opacity-[.88]'
          : 'h-[30px] px-[10px] border border-border2 bg-panel2 text-text hover:bg-raise',
    props.active && props.variant !== 'primary' && 'bg-raise text-text border-border2',
    !props.disabled && 'cursor-pointer',
  ),
)
</script>

<template>
  <button :type="props.type" :class="classes" :disabled="props.disabled" :title="props.title">
    <slot />
  </button>
</template>
