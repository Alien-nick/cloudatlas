import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Identity, Profile, ServerInfo } from '@cloudatlas/shared'
import { api, ApiError } from '@/lib/api'

export type ViewId =
  | 'topology'
  | 'health'
  | 'network'
  | 'security'
  | 'logs'
  | 'inventory'
  | 'analytics'
  | 'compliance'
  | 'cost'
  | 'simulate'
  /** A single resource, full page. Reached from a resource, not the sidebar. */
  | 'resource'
export type DetailTab =
  | 'overview'
  | 'metrics'
  | 'logs'
  | 'waf'
  | 'db-load'
  | 'connections'
  | 'security'
  | 'compliance'
  | 'cost'
  | 'tags'
  | 'json'
export type Theme = 'dark' | 'light'

export const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'topology', label: 'Topology' },
  { id: 'health', label: 'Health' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'cost', label: 'Cost' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'network', label: 'Network' },
  { id: 'security', label: 'Security Groups' },
  { id: 'logs', label: 'Logs' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'analytics', label: 'Analytics' },
]

const THEME_KEY = 'cloudatlas:theme'
const PROFILE_KEY = 'cloudatlas:profile'

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY)
  return stored === 'light' ? 'light' : 'dark'
}

export const useAppStore = defineStore('app', () => {
  const theme = ref<Theme>(readStoredTheme())
  const sidebarOpen = ref(true)
  const view = ref<ViewId>('topology')
  const detailTab = ref<DetailTab>('overview')
  /** Whether the agent panel is open. */
  const agentOpen = ref(false)
  /** Whether the ⌘K command palette is open. */
  const paletteOpen = ref(false)
  const panelOpen = ref(true)

  const info = ref<ServerInfo | null>(null)
  const profiles = ref<Profile[]>([])
  const profile = ref<string>(localStorage.getItem(PROFILE_KEY) ?? '')
  const identity = ref<Identity | null>(null)

  const loading = ref(false)
  const error = ref<string | null>(null)

  const isDemo = computed(() => info.value?.provider === 'demo')
  const accountLabel = computed(() => identity.value?.accountAlias ?? (profile.value || 'account'))
  const accountId = computed(() => {
    const id = identity.value?.accountId
    if (!id) return '—'
    // Group as 4-4-4 like the design, which reads far better than 12 digits.
    return id.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3')
  })

  watch(
    theme,
    (value) => {
      document.documentElement.dataset.theme = value
      localStorage.setItem(THEME_KEY, value)
    },
    { immediate: true },
  )

  watch(profile, (value) => {
    if (value) localStorage.setItem(PROFILE_KEY, value)
  })

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  /**
   * The view to return to from the resource page.
   *
   * Tracked rather than assumed, so Back lands where you came from — opening a
   * resource from the Inventory list and being dropped on the diagram is a
   * small thing that makes a tool feel like it is not listening.
   */
  const previousView = ref<ViewId>('topology')

  function setView(next: ViewId): void {
    // Record the view being left when the resource page opens — that is the
    // one Back returns to. (The condition was once inverted, which recorded
    // the view before that and sent Back one step too far.)
    if (next === 'resource' && view.value !== 'resource') previousView.value = view.value
    view.value = next
  }

  /** Open the full-page breakdown for whatever is selected. */
  function openResource(): void {
    setView('resource')
  }

  async function bootstrap(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [serverInfo, profileList] = await Promise.all([api.info(), api.profiles()])
      info.value = serverInfo
      profiles.value = profileList
      if (!profile.value || !profileList.some((p) => p.name === profile.value)) {
        profile.value = profileList[0]?.name ?? ''
      }
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function loadIdentity(): Promise<void> {
    if (!profile.value) return
    try {
      identity.value = await api.identity(profile.value)
    } catch {
      // The first-run screen works without an identity; the top bar falls back
      // to the profile name until a scan succeeds.
      identity.value = null
    }
  }

  function isUnimplemented(feature: string): boolean {
    return info.value?.unimplemented.includes(feature) ?? false
  }

  return {
    theme,
    sidebarOpen,
    view,
    detailTab,
    agentOpen,
    paletteOpen,
    panelOpen,
    info,
    profiles,
    profile,
    identity,
    loading,
    error,
    isDemo,
    accountLabel,
    accountId,
    toggleTheme,
    setView,
    previousView,
    openResource,
    bootstrap,
    loadIdentity,
    isUnimplemented,
  }
})
