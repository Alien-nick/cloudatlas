<script setup lang="ts">
import { computed } from 'vue'
import type { GraphNode } from '@cloudatlas/shared'
import { useGraphStore } from '@/stores/graph'
import CaEmptyState from '../ui/CaEmptyState.vue'
import CaScanNotice from '../ui/CaScanNotice.vue'

const props = defineProps<{ node: GraphNode }>()
const graph = useGraphStore()

const groups = computed(() => graph.securityGroupsOf(props.node.id))
</script>

<template>
  <div class="flex flex-col gap-5">
    <CaScanNotice
      :permissions="graph.permissionsForSection('security')"
      :failures="graph.failuresForSection('security')"
      affects="Security group rules"
    />
    <section v-for="group in groups" :key="group.id">
      <div class="mb-[9px] flex items-baseline gap-2">
        <span class="text-[12px] text-muted">{{ group.name }}</span>
        <span class="font-mono text-[11px] text-faint">{{ group.id }}</span>
      </div>
      <p v-if="group.description" class="mb-2 text-[11.5px] leading-[1.5] text-faint">
        {{ group.description }}
      </p>
      <table class="w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr>
            <th
              v-for="header in ['Dir', 'Proto', 'Port', 'Source']"
              :key="header"
              class="pb-[7px] pr-2 text-left font-sans text-[11px] font-medium text-faint last:pr-0"
            >
              {{ header }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, index) in group.rules" :key="index">
            <td
              class="border-t border-border py-[6px] pr-2"
              :class="rule.risky ? 'text-bad' : 'text-text'"
            >
              {{ rule.direction === 'in' ? 'Inbound' : 'Outbound' }}
            </td>
            <td
              class="border-t border-border py-[6px] pr-2"
              :class="rule.risky ? 'text-bad' : 'text-text'"
            >
              {{ rule.protocol === '-1' ? 'all' : rule.protocol }}
            </td>
            <td
              class="border-t border-border py-[6px] pr-2"
              :class="rule.risky ? 'text-bad' : 'text-text'"
            >
              {{ rule.port }}
            </td>
            <td
              class="border-t border-border py-[6px]"
              :class="rule.risky ? 'text-bad' : 'text-text'"
            >
              {{ rule.source }}
              <span v-if="rule.risky" class="ml-1 text-[10px]">· open to the internet</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <CaEmptyState
      v-if="groups.length === 0"
      title="No security groups"
      :description="`${node.typeLabel} resources are not attached to a security group, or none were collected.`"
    />
  </div>
</template>
