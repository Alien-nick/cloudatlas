import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  benchmarkResources,
  recommendations,
  frameworkIdSchema,
  scoreControls,
  selectFrameworks,
  summarizeControls,
  type ComplianceReport,
  type ComplianceResult,
  type FrameworkId,
} from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import { useGraphStore } from './graph'

const ALL_FRAMEWORKS = frameworkIdSchema.options

/**
 * Which frameworks apply is a property of the account, not of the person — a
 * health workload needs HIPAA and the marketing account next to it does not —
 * so the choice is remembered per account id.
 */
const selectionKey = (accountId: string): string => `cloudatlas:compliance-frameworks:${accountId}`

function readSelection(accountId: string | undefined): FrameworkId[] {
  if (!accountId) return [...ALL_FRAMEWORKS]
  try {
    const stored = JSON.parse(localStorage.getItem(selectionKey(accountId)) ?? 'null') as unknown
    if (!Array.isArray(stored)) return [...ALL_FRAMEWORKS]
    const valid = ALL_FRAMEWORKS.filter((id) => stored.includes(id))
    return valid.length > 0 ? valid : [...ALL_FRAMEWORKS]
  } catch {
    return [...ALL_FRAMEWORKS]
  }
}

export const useComplianceStore = defineStore('compliance', () => {
  const graph = useGraphStore()

  /** Every framework, as the server evaluated it. */
  const fullReport = ref<ComplianceReport | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Frameworks this account is measured against. Never empty. */
  const selected = ref<FrameworkId[]>(readSelection(graph.graph?.accountId))
  watch(
    () => graph.graph?.accountId,
    (accountId) => (selected.value = readSelection(accountId)),
  )

  function toggleFramework(id: FrameworkId): void {
    const next = selected.value.includes(id)
      ? selected.value.filter((candidate) => candidate !== id)
      : ALL_FRAMEWORKS.filter((candidate) => candidate === id || selected.value.includes(candidate))
    if (next.length === 0) return
    selected.value = next
    const accountId = graph.graph?.accountId
    if (!accountId) return
    try {
      localStorage.setItem(selectionKey(accountId), JSON.stringify(next))
    } catch {
      // Storage can be refused; the choice then lasts for this session only.
    }
  }

  /** What every view reads: only the selected frameworks and the checks they require. */
  const report = computed(() =>
    fullReport.value ? selectFrameworks(fullReport.value, selected.value) : null,
  )

  const framework = ref<FrameworkId>('hipaa')
  watch(
    selected,
    (ids) => {
      if (!ids.includes(framework.value)) framework.value = ids[0] ?? 'hipaa'
    },
    { immediate: true },
  )
  /** A VPC id, the outside-VPC scope, or null for the whole account. */
  const scopeId = ref<string | null>(null)
  const mode = ref<'controls' | 'resources' | 'recommendations'>('controls')

  const frameworks = computed(() => report.value?.frameworks ?? [])
  const scopes = computed(() => report.value?.scopes ?? [])
  const checkById = computed(() => new Map((report.value?.checks ?? []).map((c) => [c.id, c])))

  const summaries = computed(() =>
    report.value ? summarizeControls(report.value, framework.value, scopeId.value) : [],
  )
  const score = computed(() => scoreControls(summaries.value))
  const resources = computed(() => (report.value ? benchmarkResources(report.value, scopeId.value) : []))
  const fixes = computed(() => (report.value ? recommendations(report.value, scopeId.value) : []))

  /** The benchmark control id for a check, e.g. "EC2.8", when one exists. */
  const benchmarkRef = computed(() => {
    const map = new Map<string, string>()
    const fsbp = report.value?.frameworks.find((framework) => framework.id === 'aws-fsbp')
    for (const control of fsbp?.controls ?? []) {
      for (const checkId of control.checkIds) map.set(checkId, control.ref)
    }
    return map
  })

  /** Per-scope score for the selected framework, for the scope cards. */
  function scoreFor(id: string | null) {
    return report.value ? scoreControls(summarizeControls(report.value, framework.value, id)) : null
  }

  const resultsByNode = computed(() => {
    const map = new Map<string, ComplianceResult[]>()
    for (const result of report.value?.results ?? []) {
      const list = map.get(result.nodeId)
      if (list) list.push(result)
      else map.set(result.nodeId, [result])
    }
    return map
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      fullReport.value = await api.compliance()
      // A rescan can drop a VPC; do not leave the view pointed at nothing.
      if (scopeId.value && !scopes.value.some((scope) => scope.id === scopeId.value)) {
        scopeId.value = null
      }
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  // The report is a function of the scan, so it follows the scan: once when
  // the store is first used, and again whenever a new scan lands.
  watch(
    () => graph.graph?.scannedAt,
    (scannedAt) => {
      if (scannedAt) void load()
    },
    { immediate: true },
  )

  return {
    fullReport,
    report,
    selected,
    toggleFramework,
    loading,
    error,
    framework,
    scopeId,
    mode,
    frameworks,
    scopes,
    checkById,
    summaries,
    score,
    scoreFor,
    resources,
    fixes,
    benchmarkRef,
    resultsByNode,
    load,
  }
})
