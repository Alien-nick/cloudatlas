import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  SimChange,
  SimResource,
  SimResourceType,
  Simulated,
  SimulationImpact,
  SimulationScope,
  SimulationSummary,
  SettingValue,
} from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'
import { placeResource } from '@/lib/simPlacement'

/**
 * The simulation being edited.
 *
 * Every edit appends to the change log and saves it; the server replays the
 * log onto the snapshot and answers with the simulated graph. Impact is loaded
 * separately, and debounced, because it prices the whole graph.
 */
export const useSimulationStore = defineStore('simulation', () => {
  const list = ref<SimulationSummary[]>([])
  const current = ref<Simulated | null>(null)
  const impact = ref<SimulationImpact | null>(null)
  const selectedId = ref<string | null>(null)
  const loading = ref(false)
  const impactLoading = ref(false)
  const error = ref<string | null>(null)
  /**
   * A request for the canvas to pan to a node. The nonce makes asking twice
   * for the same node move the view again, after the user has panned away.
   */
  const focusRequest = ref<{ id: string; nonce: number } | null>(null)
  /** The resource just added, pulsed on the canvas so it is easy to spot. */
  const justAdded = ref<string | null>(null)
  /** The palette item being dragged, so the canvas can show where it may go. */
  const draggingType = ref<SimResourceType | null>(null)
  /** Saving a change: the canvas shows it, and a second drop waits. */
  const saving = ref(false)

  const changes = computed(() => current.value?.simulation.changes ?? [])
  const selected = computed(() => current.value?.graph.nodes.find((node) => node.id === selectedId.value) ?? null)

  async function guard<T>(run: () => Promise<T>): Promise<T | null> {
    error.value = null
    try {
      return await run()
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
      return null
    }
  }

  async function loadList(): Promise<void> {
    loading.value = true
    const result = await guard(() => api.simulations())
    if (result) list.value = result
    loading.value = false
  }

  let impactTimer: number | null = null
  function scheduleImpact(): void {
    if (impactTimer !== null) window.clearTimeout(impactTimer)
    impactTimer = window.setTimeout(() => void loadImpact(), 350)
  }

  async function loadImpact(): Promise<void> {
    const id = current.value?.simulation.id
    if (!id) return
    impactLoading.value = true
    const result = await guard(() => api.simulationImpact(id))
    if (result && current.value?.simulation.id === id) impact.value = result
    impactLoading.value = false
  }

  function adopt(next: Simulated | null): void {
    if (!next) return
    current.value = next
    if (selectedId.value && !next.graph.nodes.some((node) => node.id === selectedId.value)) selectedId.value = null
    scheduleImpact()
  }

  async function create(name: string, scope: SimulationScope | null = null): Promise<void> {
    adopt(await guard(() => api.createSimulation(name, scope)))
    impact.value = null
    await loadList()
  }

  async function open(id: string): Promise<void> {
    loading.value = true
    impact.value = null
    selectedId.value = null
    adopt(await guard(() => api.simulation(id)))
    loading.value = false
  }

  function close(): void {
    current.value = null
    impact.value = null
    selectedId.value = null
    void loadList()
  }

  async function save(next: SimChange[]): Promise<void> {
    const id = current.value?.simulation.id
    if (!id) return
    saving.value = true
    adopt(await guard(() => api.saveSimulation(id, { changes: next })))
    saving.value = false
  }

  const push = (change: SimChange): Promise<void> => save([...changes.value, change])

  function newId(prefix: string): string {
    return `sim-${prefix}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** Select a node and bring it into view. */
  function focus(id: string): void {
    selectedId.value = id
    focusRequest.value = { id, nonce: (focusRequest.value?.nonce ?? 0) + 1 }
  }

  let pulseTimer: number | null = null
  async function add(resource: Omit<SimResource, 'id'>): Promise<string | null> {
    const id = newId(resource.type)
    await push({ op: 'add', resource: { ...resource, id } })
    if (!current.value?.graph.nodes.some((node) => node.id === id)) return null
    focus(id)
    justAdded.value = id
    if (pulseTimer !== null) window.clearTimeout(pulseTimer)
    pulseTimer = window.setTimeout(() => (justAdded.value = null), 2600)
    return id
  }

  /**
   * Add with defaults, placed by where it was dropped or which container is
   * selected. One gesture; the settings can be changed afterwards.
   */
  async function quickAdd(type: SimResourceType, targetId: string | null): Promise<string | null> {
    const graph = current.value?.graph
    if (!graph) return null
    const placement = placeResource(graph, type, targetId)
    if ('error' in placement) {
      error.value = placement.error
      return null
    }
    return add(placement)
  }

  const update = (nodeId: string, settings: Record<string, SettingValue>) => push({ op: 'update', nodeId, settings })
  const remove = (nodeId: string) => push({ op: 'remove', nodeId })
  const connect = (source: string, target: string, port: number | null) =>
    push({ op: 'connect', id: newId('link').slice(4), source, target, port })

  /** Drop one change from the log; later changes that relied on it show up as problems. */
  const discard = (index: number) => save(changes.value.filter((_, i) => i !== index))

  /** Take back the last change. Every edit is one entry in the log, so this is exact. */
  async function undo(): Promise<void> {
    if (changes.value.length === 0 || saving.value) return
    await discard(changes.value.length - 1)
  }

  async function disconnect(connectionId: string): Promise<void> {
    // A connection this simulation made is simply taken out of the log.
    const index = changes.value.findIndex((change) => change.op === 'connect' && change.id === connectionId)
    if (index >= 0) await discard(index)
  }

  async function rename(name: string): Promise<void> {
    const id = current.value?.simulation.id
    if (id) adopt(await guard(() => api.saveSimulation(id, { name })))
  }

  async function rebase(): Promise<void> {
    const id = current.value?.simulation.id
    if (id) adopt(await guard(() => api.rebaseSimulation(id)))
  }

  async function destroy(id: string): Promise<void> {
    await guard(() => api.deleteSimulation(id))
    if (current.value?.simulation.id === id) close()
    else await loadList()
  }

  return {
    list,
    current,
    impact,
    selectedId,
    selected,
    focusRequest,
    justAdded,
    focus,
    quickAdd,
    draggingType,
    saving,
    undo,
    loading,
    impactLoading,
    error,
    changes,
    loadList,
    loadImpact,
    create,
    open,
    close,
    add,
    update,
    remove,
    connect,
    disconnect,
    discard,
    rename,
    rebase,
    destroy,
  }
})
