<script setup lang="ts">
import { ref, watch } from 'vue'
import type { SimulationExport } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import { downloadText } from '@/lib/compliance'
import { copyText } from '@/lib/utils'

/**
 * The simulation as something that builds it. Shown in full before it can be
 * copied or saved: the point is that a person reads it first.
 */

const props = defineProps<{ simulationId: string; name: string; format: 'cli' | 'terraform' }>()
const emit = defineEmits<{ close: [] }>()

const result = ref<SimulationExport | null>(null)
const error = ref<string | null>(null)
const copied = ref(false)

watch(
  () => [props.simulationId, props.format] as const,
  async ([id, format]) => {
    result.value = null
    error.value = null
    try {
      result.value = await api.exportSimulation(id, format)
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
    }
  },
  { immediate: true },
)

async function copy(): Promise<void> {
  if (result.value && (await copyText(result.value.text))) {
    copied.value = true
    window.setTimeout(() => (copied.value = false), 1600)
  }
}

function download(): void {
  if (!result.value) return
  const base = props.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'simulation'
  if (props.format === 'terraform') downloadText(`${base}.tf`, result.value.text, 'text/plain')
  else downloadText(`${base}.sh`, result.value.text, 'text/x-shellscript')
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" @click.self="emit('close')">
    <div class="ca-panel-shadow flex max-h-full w-[980px] max-w-full flex-col rounded-[12px] border border-border2 bg-panel">
      <div class="flex items-center gap-3 border-b border-border px-[16px] py-[12px]">
        <span class="text-[14px] font-semibold">{{ format === 'terraform' ? 'Terraform' : 'AWS CLI script' }}</span>
        <span class="text-[11.5px] text-muted">{{ name }}</span>
        <div class="ml-auto flex gap-[6px]">
          <button type="button" class="h-[28px] cursor-pointer rounded-[6px] border border-border2 bg-raise px-[10px] text-[11.5px] hover:border-text disabled:opacity-50" :disabled="!result" @click="copy">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <button type="button" class="h-[28px] cursor-pointer rounded-[6px] border border-border2 bg-raise px-[10px] text-[11.5px] hover:border-text disabled:opacity-50" :disabled="!result" @click="download">
            Download {{ format === 'terraform' ? '.tf' : '.sh' }}
          </button>
          <button type="button" class="h-[28px] cursor-pointer px-[6px] text-[13px] text-faint hover:text-text" title="Close" @click="emit('close')">✕</button>
        </div>
      </div>
      <p class="border-b border-border px-[16px] py-[8px] text-[11.5px] leading-[1.5] text-warn">
        ⚠ CloudAtlas never runs this. Review every line before running it against your account: it creates
        billable resources and changes existing ones. Replace every &lt;placeholder&gt; first.
      </p>
      <p v-if="error" class="px-[16px] py-[12px] text-[12px] text-bad">{{ error }}</p>
      <pre
        v-else
        class="min-h-[200px] flex-1 overflow-auto whitespace-pre px-[16px] py-[12px] font-mono text-[11px] leading-[1.6] text-text"
      >{{ result?.text ?? 'Generating…' }}</pre>
      <ul v-if="result?.notes.length" class="border-t border-border px-[16px] py-[10px] text-[11.5px] text-muted">
        <li v-for="(note, i) in result.notes" :key="i">· {{ note }}</li>
      </ul>
    </div>
  </div>
</template>
