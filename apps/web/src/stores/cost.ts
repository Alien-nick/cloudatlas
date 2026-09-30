import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { monthlyByNode, runRateTotal, savingsTotal, type CostReport, type Saving } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import { useGraphStore } from './graph'

export type CostMode = 'spend' | 'run-rate' | 'savings'

/** What a drill-down page is about. `key` is a service name, region, VPC id or type label. */
export interface CostDetail {
  kind: 'service' | 'region' | 'vpc' | 'type'
  key: string
  /** The mode it was opened from, so Back returns there. */
  from: CostMode
}

export const useCostStore = defineStore('cost', () => {
  const graph = useGraphStore()

  const report = ref<CostReport | null>(null)
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref<string | null>(null)
  const mode = ref<CostMode>('spend')
  const detail = ref<CostDetail | null>(null)

  function openDetail(kind: CostDetail['kind'], key: string): void {
    detail.value = { kind, key, from: mode.value }
  }

  function closeDetail(): void {
    if (detail.value) mode.value = detail.value.from
    detail.value = null
  }

  const byNode = computed(() => (report.value ? monthlyByNode(report.value.runRate) : new Map<string, number>()))
  const runRate = computed(() => (report.value ? runRateTotal(report.value.runRate) : 0))
  const potentialSavings = computed(() => (report.value ? savingsTotal(report.value.savings) : 0))

  const savingsByNode = computed(() => {
    const map = new Map<string, Saving[]>()
    for (const saving of report.value?.savings ?? []) map.set(saving.nodeId, [...(map.get(saving.nodeId) ?? []), saving])
    return map
  })

  async function load(refresh = false): Promise<void> {
    if (refresh) refreshing.value = true
    else loading.value = true
    error.value = null
    try {
      report.value = await api.cost(refresh)
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
    } finally {
      loading.value = false
      refreshing.value = false
    }
  }

  /** Turning Cost Explorer on is the user's call: it bills per request. */
  async function setCostExplorer(enabled: boolean): Promise<void> {
    await api.setCostExplorer(enabled)
    await load()
  }

  // Estimates and savings describe a scan, so they follow the scan.
  watch(
    () => graph.graph?.scannedAt,
    (scannedAt) => {
      if (scannedAt) void load()
    },
    { immediate: true },
  )

  return {
    report,
    loading,
    refreshing,
    error,
    mode,
    detail,
    openDetail,
    closeDetail,
    byNode,
    runRate,
    potentialSavings,
    savingsByNode,
    load,
    setCostExplorer,
  }
})
