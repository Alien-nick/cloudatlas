import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isPostureFinding, type Alarm, type Finding } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'

export const useHealthStore = defineStore('health', () => {
  const findings = ref<Finding[]>([])
  const alarms = ref<Alarm[]>([])
  const evaluatedAt = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Live incidents, newest first. Posture issues are listed separately. */
  const incidents = computed(() =>
    findings.value
      .filter((f) => !isPostureFinding(f.kind))
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt),
  )

  const posture = computed(() => findings.value.filter((f) => isPostureFinding(f.kind)))

  const criticalCount = computed(
    () => incidents.value.filter((f) => f.severity === 'critical').length,
  )
  const warningCount = computed(
    () => incidents.value.filter((f) => f.severity === 'warning').length + posture.value.length,
  )

  const findingsByNode = computed(() => {
    const map = new Map<string, Finding[]>()
    for (const finding of findings.value) {
      const list = map.get(finding.nodeId)
      if (list) list.push(finding)
      else map.set(finding.nodeId, [finding])
    }
    return map
  })

  const firingAlarms = computed(() => alarms.value.filter((a) => a.state === 'ALARM'))

  function alarmsForNode(nodeId: string): Alarm[] {
    return alarms.value.filter((a) => a.nodeId === nodeId)
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [findingsResponse, alarmsResponse] = await Promise.all([api.findings(), api.alarms()])
      findings.value = findingsResponse.findings
      evaluatedAt.value = findingsResponse.evaluatedAt
      alarms.value = alarmsResponse.alarms
    } catch (cause) {
      // Health is additive: a failure here must not blank the diagram.
      error.value = cause instanceof ApiError ? cause.message : String(cause)
      findings.value = []
      alarms.value = []
    } finally {
      loading.value = false
    }
  }

  return {
    findings,
    alarms,
    evaluatedAt,
    loading,
    error,
    incidents,
    posture,
    criticalCount,
    warningCount,
    findingsByNode,
    firingAlarms,
    alarmsForNode,
    load,
  }
})
