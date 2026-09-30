<script setup lang="ts">
import type { SettingField, SettingValue } from '@cloudatlas/shared'

/** Fields straight from the catalog, so a new resource type needs no new form. */

defineProps<{ fields: SettingField[] }>()
const model = defineModel<Record<string, SettingValue>>({ required: true })

const input =
  'h-[28px] w-full rounded-[6px] border border-border2 bg-panel2 px-[8px] font-mono text-[11.5px] text-text outline-none focus:border-text'

function set(key: string, value: SettingValue): void {
  model.value = { ...model.value, [key]: value }
}
</script>

<template>
  <div class="flex flex-col gap-[9px]">
    <label v-for="field in fields" :key="field.key" class="flex flex-col gap-[4px]">
      <template v-if="field.kind === 'boolean'">
        <span class="flex cursor-pointer items-center gap-2 text-[11.5px] text-text">
          <input
            type="checkbox"
            class="accent-[var(--ca-network)]"
            :checked="model[field.key] === true || model[field.key] === 'true'"
            @change="set(field.key, ($event.target as HTMLInputElement).checked)"
          />
          {{ field.label }}
        </span>
      </template>
      <template v-else>
        <span class="text-[10.5px] font-semibold text-muted">{{ field.label }}</span>
        <select
          v-if="field.kind === 'select'"
          :class="input"
          :value="String(model[field.key] ?? field.default)"
          @change="set(field.key, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input
          v-else
          :class="input"
          :type="field.kind === 'number' ? 'number' : 'text'"
          :value="model[field.key] ?? field.default"
          spellcheck="false"
          @change="
            set(
              field.key,
              field.kind === 'number'
                ? Number(($event.target as HTMLInputElement).value)
                : ($event.target as HTMLInputElement).value,
            )
          "
        />
      </template>
      <span v-if="field.help" class="text-[10.5px] leading-[1.4] text-faint">{{ field.help }}</span>
    </label>
  </div>
</template>
