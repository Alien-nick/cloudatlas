<script setup lang="ts">
/**
 * Honest empty state for a feature that has not shipped yet.
 *
 * Currently unused: Logs was the last view behind one. Kept because the pattern
 * — say what is missing, which milestone it lands in, and what already works —
 * is the right answer for the agent panel in M5, and re-deriving it later would
 * lose the wording.
 */
defineProps<{ title: string; milestone: string; description: string; shipped?: string[] }>()
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-[38px] shrink-0 items-center gap-[10px] border-b border-border bg-panel px-[14px]">
      <span class="text-[12.5px] font-semibold">{{ title }}</span>
      <span class="text-[11.5px] text-faint">{{ milestone }}</span>
    </div>
    <div class="ca-dotgrid flex flex-1 items-center justify-center p-6">
      <div class="w-[460px] max-w-full rounded-[12px] border border-border2 bg-panel p-6">
        <div class="mb-2 text-[15px] font-semibold">{{ title }}</div>
        <p class="text-[12.5px] leading-[1.6] text-muted">{{ description }}</p>
        <div v-if="shipped && shipped.length > 0" class="mt-4">
          <div class="ca-eyebrow mb-2">Already working</div>
          <ul class="flex flex-col gap-[5px]">
            <li v-for="item in shipped" :key="item" class="flex gap-2 text-[12px] text-muted">
              <span class="text-ok">✓</span>{{ item }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
