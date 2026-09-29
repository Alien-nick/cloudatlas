<script setup lang="ts">
import { ref } from 'vue'
import { copyText } from '@/lib/utils'

/**
 * A fix, as commands the user copies and runs themselves.
 *
 * The block says so every time it appears. CloudAtlas holds no write
 * permission and never will; the wording keeps anyone from reading a Copy
 * button as an Apply button.
 */

const props = withDefaults(
  defineProps<{
    /** The text copied: one resource's commands, or a whole script. */
    script: string
    caution?: string | null
    needsInput?: boolean
    /** Rendered above the commands, e.g. "5 resources". */
    label?: string
    /** Clip long scripts until expanded. */
    collapsible?: boolean
  }>(),
  { caution: null, needsInput: false, label: undefined, collapsible: false },
)

const copied = ref(false)
const open = ref(!props.collapsible)

async function copy(): Promise<void> {
  if (await copyText(props.script)) {
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  }
}
</script>

<template>
  <div class="rounded-[8px] border border-border bg-panel2">
    <div class="flex items-center gap-2 border-b border-border px-[9px] py-[5px]">
      <span class="font-mono text-[10.5px] text-faint">$ aws</span>
      <span v-if="label" class="text-[11px] text-muted">{{ label }}</span>
      <span
        v-if="needsInput"
        class="rounded-full border border-border2 px-[6px] text-[10px] text-warn"
        title="A command holds a <placeholder> only you can fill in"
      >
        fill in &lt;placeholders&gt;
      </span>
      <button
        v-if="collapsible"
        type="button"
        class="ml-auto cursor-pointer text-[11px] text-muted hover:text-text"
        @click="open = !open"
      >
        {{ open ? 'Hide' : 'Show' }} commands
      </button>
      <button
        type="button"
        class="cursor-pointer rounded-[5px] border border-border2 bg-raise px-[8px] py-[2px] text-[11px] font-medium text-text hover:border-text"
        :class="collapsible ? '' : 'ml-auto'"
        @click="copy"
      >
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>
    <p v-if="caution" class="border-b border-border px-[9px] py-[6px] text-[11px] leading-[1.5] text-warn">
      ⚠ {{ caution }}
    </p>
    <pre
      v-if="open"
      class="max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] px-[9px] py-[7px] font-mono text-[10.5px] leading-[1.55] text-text"
    >{{ script.trimEnd() }}</pre>
    <p class="px-[9px] pb-[6px] text-[10.5px] text-faint">
      CloudAtlas never runs this. Review it, then run it yourself with the AWS CLI.
    </p>
  </div>
</template>
