<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    class="flex w-full cursor-pointer items-center gap-[9px] rounded-[8px] border border-border bg-panel2 px-[10px] py-[9px] text-left text-[12.5px] hover:border-border2"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span
      class="flex h-[15px] w-[26px] items-center rounded-full p-[2px] transition-colors"
      :class="modelValue ? 'bg-ok' : 'bg-border2'"
    >
      <span
        class="h-[11px] w-[11px] rounded-full bg-white transition-[margin]"
        :style="{ marginLeft: modelValue ? '11px' : '0' }"
      />
    </span>
    <span>{{ label }}</span>
  </button>
</template>
