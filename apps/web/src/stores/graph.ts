import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CATEGORY_LABELS,
  INTERNET_NODE_ID,
  isContainerType,
  type CollectorFailure,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type MissingPermission,
  type NodeCategory,
  type ScanProgress,
} from '@cloudatlas/shared'
import { api, ApiError, streamScan } from '@/lib/api'
import { shortNames } from '@/lib/names'
import { useAppStore } from './app'

const ALL_CATEGORIES: NodeCategory[] = [
  'compute',
  'network',
  'database',
  'storage',
  'integration',
  'security',
]

/** Tag keys we treat as "which environment is this". */
const ENV_TAG_KEYS = ['Environment', 'environment', 'Env', 'env']

export function environmentOf(node: GraphNode): string | null {
  for (const key of ENV_TAG_KEYS) {
    const tag = node.tags.find((t) => t.key === key)
    if (tag) return tag.value
  }
  return null
}

export const useGraphStore = defineStore('graph', () => {
  const app = useAppStore()

  const graph = ref<Graph | null>(null)
  const scanning = ref(false)
  const scanProgress = ref<Map<string, ScanProgress>>(new Map())
  const scanError = ref<string | null>(null)
  const lastScanAt = ref<number | null>(null)

  const selectedRegions = ref<string[]>([])
  const categories = ref<NodeCategory[]>([...ALL_CATEGORIES])
  const envFilter = ref<string[]>([])
  const tagKeyFilter = ref('')
  const tagValueFilter = ref('')
  /** Empty means every VPC; otherwise only these. */
  const vpcFilter = ref<string[]>([])
  const hideUnconnected = ref(false)
  const collapsedContainers = ref<Set<string>>(new Set())

  const selectedId = ref<string | null>(null)
  const hoveredId = ref<string | null>(null)

  /** Issues seen live during a scan, before the final graph lands. */
  const liveWarnings = ref<MissingPermission[]>([])
  const liveFailures = ref<CollectorFailure[]>([])

  let cancelStream: (() => void) | null = null

  // ---- raw slices -------------------------------------------------------

  const allNodes = computed<GraphNode[]>(() => graph.value?.nodes ?? [])
  const allEdges = computed<GraphEdge[]>(() => graph.value?.edges ?? [])

  const nodeById = computed(() => {
    const map = new Map<string, GraphNode>()
    for (const node of allNodes.value) map.set(node.id, node)
    return map
  })

  const resourceNodes = computed(() =>
    allNodes.value.filter((n) => !isContainerType(n.type) && n.type !== 'internet'),
  )

  const regionOptions = computed(() => graph.value?.regions ?? [])

  // --- scan issues -------------------------------------------------------

  /** Permissions the scan turned out not to have. Never fatal. */
  const missingPermissions = computed<MissingPermission[]>(() =>
    graph.value ? graph.value.missingPermissions : liveWarnings.value,
  )

  /** Calls that failed for a reason no classifier recognised. */
  const collectorFailures = computed<CollectorFailure[]>(() =>
    graph.value ? (graph.value.collectorFailures ?? []) : liveFailures.value,
  )

  const hasScanIssues = computed(
    () => missingPermissions.value.length > 0 || collectorFailures.value.length > 0,
  )

  /** Distinct missing actions, for the top-bar count. */
  const missingActions = computed(
    () => new Set(missingPermissions.value.map((p) => p.action)).size,
  )

  function permissionsForSection(section: string): MissingPermission[] {
    return missingPermissions.value.filter((p) => p.section === section)
  }

  function failuresForSection(section: string): CollectorFailure[] {
    return collectorFailures.value.filter((f) => f.section === section)
  }

  /** Sections affected by either kind of issue, for grouped display. */
  const affectedSections = computed(() => {
    const sections = new Set<string>()
    for (const permission of missingPermissions.value) sections.add(permission.section)
    for (const failure of collectorFailures.value) sections.add(failure.section)
    return [...sections].sort()
  })

  const environments = computed(() => {
    const seen = new Set<string>()
    for (const node of resourceNodes.value) {
      const env = environmentOf(node)
      if (env) seen.add(env)
    }
    return [...seen].sort()
  })

  const categoryCounts = computed(() => {
    const counts = new Map<NodeCategory, number>()
    for (const category of ALL_CATEGORIES) counts.set(category, 0)
    for (const node of resourceNodes.value) {
      counts.set(node.category, (counts.get(node.category) ?? 0) + 1)
    }
    return ALL_CATEGORIES.map((id) => ({
      id,
      label: CATEGORY_LABELS[id],
      count: counts.get(id) ?? 0,
    }))
  })

  // ---- filtering --------------------------------------------------------

  /** Security Groups view is the only place the synthetic internet node appears. */
  const showsInternet = computed(() => app.view === 'security')

  const connectedIds = computed(() => {
    const ids = new Set<string>()
    for (const edge of allEdges.value) {
      ids.add(edge.source)
      ids.add(edge.target)
    }
    return ids
  })

  function passesFilters(node: GraphNode): boolean {
    if (!categories.value.includes(node.category)) return false

    if (envFilter.value.length > 0) {
      const env = environmentOf(node)
      if (!env || !envFilter.value.includes(env)) return false
    }

    const key = tagKeyFilter.value.trim().toLowerCase()
    if (key) {
      const value = tagValueFilter.value.trim().toLowerCase()
      const match = node.tags.some(
        (tag) =>
          tag.key.toLowerCase() === key && (!value || tag.value.toLowerCase().includes(value)),
      )
      if (!match) return false
    }

    // A resource with no VPC — a bucket, a distribution, a hosted zone — is
    // hidden by a VPC filter, because the filter is a statement about which
    // network you are looking at and those are not in one.
    if (vpcFilter.value.length > 0 && (!node.vpcId || !vpcFilter.value.includes(node.vpcId))) {
      return false
    }

    if (hideUnconnected.value && !connectedIds.value.has(node.id)) return false
    return true
  }

  /** Resource nodes that survive the sidebar filters. */
  const visibleResources = computed(() => {
    const nodes = resourceNodes.value.filter(passesFilters)
    if (showsInternet.value) {
      const internet = nodeById.value.get(INTERNET_NODE_ID)
      if (internet) nodes.push(internet)
    }
    return nodes
  })

  /** Container nodes are kept only when something inside them survived. */
  const visibleNodes = computed(() => {
    const keep = new Set<string>()
    const byId = nodeById.value

    for (const node of visibleResources.value) {
      keep.add(node.id)
      let parentId = node.parentId
      // Walk up so a surviving task keeps its subnet, AZ, VPC and region.
      while (parentId) {
        if (keep.has(parentId)) break
        keep.add(parentId)
        parentId = byId.get(parentId)?.parentId ?? null
      }
    }

    // Preserve the source ordering so parents precede children, which Vue Flow
    // requires when it wires up compound nodes.
    return allNodes.value.filter((n) => keep.has(n.id))
  })

  const visibleNodeIds = computed(() => new Set(visibleNodes.value.map((n) => n.id)))

  /**
   * VPCs in the current scan, with how many resources each holds.
   *
   * Counted from the unfiltered set on purpose: a filter that reports "0" for
   * the VPC you just deselected gives no way back.
   */
  const vpcs = computed(() => {
    const counts = new Map<string, number>()
    for (const node of resourceNodes.value) {
      if (!node.vpcId) continue
      counts.set(node.vpcId, (counts.get(node.vpcId) ?? 0) + 1)
    }
    return allNodes.value
      .filter((node) => node.type === 'vpc')
      .map((node) => ({
        id: node.id,
        name: node.name,
        cidr: node.cidr ?? null,
        region: node.region,
        count: counts.get(node.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  })

  function toggleVpc(id: string): void {
    vpcFilter.value = vpcFilter.value.includes(id)
      ? vpcFilter.value.filter((entry) => entry !== id)
      : [...vpcFilter.value, id]
  }

  /**
   * Display names with the VPC's shared naming prefix removed.
   *
   * Derived from every node rather than the visible set, so filtering does not
   * change how a resource is labelled — a name that shifts when you tick a box
   * is worse than a long one.
   */
  const displayNames = computed(() => shortNames(allNodes.value))

  function displayName(node: { id: string; name: string }): string {
    return displayNames.value.get(node.id) ?? node.name
  }

  const visibleEdges = computed(() => {
    const ids = visibleNodeIds.value
    const securityView = app.view === 'security'
    return allEdges.value.filter((edge) => {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return false
      // Risky-rule edges are the point of the Security Groups view and noise
      // everywhere else.
      if (edge.kind === 'risk' && !securityView) return false
      return true
    })
  })

  const focusCount = computed(() => {
    const resources = visibleNodes.value.filter(
      (n) => !isContainerType(n.type) && n.type !== 'internet',
    ).length
    return `${resources} resources · ${visibleEdges.value.length} connections`
  })

  const selectedNode = computed(() =>
    selectedId.value ? (nodeById.value.get(selectedId.value) ?? null) : null,
  )

  /** Node ids to keep at full opacity while hovering; null means "no hover". */
  const highlightedIds = computed<Set<string> | null>(() => {
    if (!hoveredId.value) return null
    const ids = new Set<string>([hoveredId.value])
    for (const edge of visibleEdges.value) {
      if (edge.source === hoveredId.value) ids.add(edge.target)
      if (edge.target === hoveredId.value) ids.add(edge.source)
    }
    return ids
  })

  function connectionsOf(nodeId: string): { inbound: GraphEdge[]; outbound: GraphEdge[] } {
    const inbound: GraphEdge[] = []
    const outbound: GraphEdge[] = []
    for (const edge of allEdges.value) {
      if (edge.target === nodeId) inbound.push(edge)
      if (edge.source === nodeId) outbound.push(edge)
    }
    return { inbound, outbound }
  }

  function securityGroupsOf(nodeId: string) {
    const node = nodeById.value.get(nodeId)
    if (!node) return []
    const groups = graph.value?.securityGroups ?? []
    return groups.filter((sg) => node.securityGroupIds.includes(sg.id))
  }

  // ---- actions ----------------------------------------------------------

  function select(nodeId: string | null): void {
    selectedId.value = nodeId
    if (nodeId) app.panelOpen = true
  }

  function toggleCategory(category: NodeCategory): void {
    categories.value = categories.value.includes(category)
      ? categories.value.filter((c) => c !== category)
      : [...categories.value, category]
  }

  function toggleEnv(env: string): void {
    envFilter.value = envFilter.value.includes(env)
      ? envFilter.value.filter((e) => e !== env)
      : [...envFilter.value, env]
  }

  function toggleRegion(region: string): void {
    selectedRegions.value = selectedRegions.value.includes(region)
      ? selectedRegions.value.filter((r) => r !== region)
      : [...selectedRegions.value, region]
  }

  function toggleCollapsed(containerId: string): void {
    const next = new Set(collapsedContainers.value)
    if (next.has(containerId)) next.delete(containerId)
    else next.add(containerId)
    collapsedContainers.value = next
  }

  function adoptGraph(next: Graph): void {
    graph.value = next
    lastScanAt.value = next.scannedAt
    if (selectedRegions.value.length === 0) {
      selectedRegions.value = next.regions.filter((r) => r.count > 0).map((r) => r.id)
    }
    if (!selectedId.value) {
      // Open on the most interesting thing rather than an arbitrary node.
      const critical = next.nodes.find((n) => n.health === 'critical')
      selectedId.value = critical?.id ?? next.nodes.find((n) => !isContainerType(n.type))?.id ?? null
    }
  }

  async function loadCachedGraph(): Promise<boolean> {
    try {
      const cached = await api.graph()
      if (!cached) return false
      adoptGraph(cached)
      return true
    } catch (cause) {
      scanError.value = cause instanceof ApiError ? cause.message : String(cause)
      return false
    }
  }

  function startScan(profile: string, regions: string[]): void {
    if (scanning.value) return
    scanning.value = true
    scanError.value = null
    liveWarnings.value = []
    liveFailures.value = []
    scanProgress.value = new Map(
      regions.map((region) => [
        region,
        { region, state: 'queued' as const, progress: 0, step: null, resourceCount: 0, error: null },
      ]),
    )

    cancelStream?.()
    cancelStream = streamScan(profile, regions, {
      onEvent: (event) => {
        switch (event.type) {
          case 'progress': {
            const next = new Map(scanProgress.value)
            next.set(event.progress.region, event.progress)
            scanProgress.value = next
            break
          }
          case 'warning':
            liveWarnings.value = [...liveWarnings.value, event.warning]
            break
          case 'failure':
            liveFailures.value = [...liveFailures.value, event.failure]
            break
          case 'done':
            adoptGraph(event.graph)
            scanning.value = false
            break
          case 'error':
            scanError.value = event.message
            scanning.value = false
            break
          default:
            break
        }
      },
      onError: (message) => {
        scanError.value = message
        scanning.value = false
      },
    })
  }

  function cancelScan(): void {
    cancelStream?.()
    cancelStream = null
    scanning.value = false
  }

  async function refresh(profile: string): Promise<void> {
    const regions = selectedRegions.value.length > 0 ? selectedRegions.value : ['us-east-1']
    startScan(profile, regions)
  }

  return {
    graph,
    scanning,
    scanProgress,
    scanError,
    lastScanAt,
    selectedRegions,
    categories,
    envFilter,
    tagKeyFilter,
    tagValueFilter,
    vpcFilter,
    vpcs,
    toggleVpc,
    displayNames,
    displayName,
    hideUnconnected,
    collapsedContainers,
    selectedId,
    hoveredId,
    allNodes,
    allEdges,
    nodeById,
    resourceNodes,
    regionOptions,
    environments,
    categoryCounts,
    visibleNodes,
    visibleEdges,
    visibleResources,
    focusCount,
    selectedNode,
    highlightedIds,
    missingPermissions,
    collectorFailures,
    hasScanIssues,
    missingActions,
    affectedSections,
    permissionsForSection,
    failuresForSection,
    connectionsOf,
    securityGroupsOf,
    select,
    toggleCategory,
    toggleEnv,
    toggleRegion,
    toggleCollapsed,
    loadCachedGraph,
    startScan,
    cancelScan,
    refresh,
  }
})
