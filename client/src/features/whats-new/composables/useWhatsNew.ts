import { computed, ref } from 'vue'
import type { ReleaseNote, ReleaseNotesResponse, WhatsNewPreferences } from '@bookorbit/types'
import { api } from '@/lib/api'
import { useAppInfo } from '@/features/settings/composables/useAppInfo'
import { isNewer, isSemverTag, shouldShowPopup } from '../lib/whats-new.logic'

const lastSeenVersion = ref<string | null>(null)
const popupEnabled = ref(true)
const releases = ref<ReleaseNote[]>([])
const hasMore = ref(false)
const popupOpen = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

let prefsLoaded = false
let evaluated = false
let evaluating = false
let dismissedThisSession = false

/**
 * Clears the module-scope singleton so a user switch in the same SPA session can't inherit the
 * previous user's seen-state. Call from auth teardown (see clearAuth in useAuth).
 */
export function resetWhatsNew(): void {
  lastSeenVersion.value = null
  popupEnabled.value = true
  releases.value = []
  hasMore.value = false
  popupOpen.value = false
  loading.value = false
  error.value = null
  prefsLoaded = false
  evaluated = false
  evaluating = false
  dismissedThisSession = false
}

export function useWhatsNew() {
  const { version, loadAppInfo } = useAppInfo()

  const hasUnseen = computed(() => releases.value.length > 0)

  async function loadPrefs(): Promise<void> {
    if (prefsLoaded) return
    const res = await api('/api/v1/user-preferences/whats-new')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { settings: WhatsNewPreferences }
    lastSeenVersion.value = data.settings.lastSeenVersion
    popupEnabled.value = data.settings.popupEnabled
    prefsLoaded = true
  }

  async function persist(settings: Partial<WhatsNewPreferences>): Promise<Response> {
    return api('/api/v1/user-preferences/whats-new', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    })
  }

  async function saveLastSeen(value: string): Promise<void> {
    lastSeenVersion.value = value
    releases.value = []
    hasMore.value = false
    await persist({ lastSeenVersion: value }).catch(() => {})
  }

  async function evaluate(): Promise<void> {
    if (evaluated || evaluating) return
    evaluating = true
    loading.value = true
    error.value = null
    try {
      await loadAppInfo()
      await loadPrefs()

      const current = version.value
      if (!isSemverTag(current)) return

      if (lastSeenVersion.value === null) {
        await saveLastSeen(current)
        return
      }

      if (!isNewer(current, lastSeenVersion.value)) return

      const res = await api(`/api/v1/release-notes?since=${encodeURIComponent(lastSeenVersion.value)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ReleaseNotesResponse
      releases.value = data.releases
      hasMore.value = data.hasMore
      evaluated = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load release notes'
    } finally {
      evaluating = false
      loading.value = false
    }
  }

  function syncPopup(routeName: string | null | undefined): void {
    if (
      shouldShowPopup({ hasUnseen: hasUnseen.value, popupEnabled: popupEnabled.value, dismissedThisSession, routeName, alreadyOpen: popupOpen.value })
    ) {
      popupOpen.value = true
    }
  }

  async function acknowledge(): Promise<void> {
    popupOpen.value = false
    if (isSemverTag(version.value)) await saveLastSeen(version.value)
  }

  function remindLater(): void {
    dismissedThisSession = true
    popupOpen.value = false
  }

  async function markArchiveSeen(): Promise<void> {
    await loadAppInfo()
    await loadPrefs().catch(() => {})
    const current = version.value
    if (isSemverTag(current) && (lastSeenVersion.value === null || isNewer(current, lastSeenVersion.value))) {
      await saveLastSeen(current)
    }
  }

  async function setPopupEnabled(enabled: boolean): Promise<void> {
    popupEnabled.value = enabled
    const res = await persist({ popupEnabled: enabled })
    if (!res.ok) {
      popupEnabled.value = !enabled
      throw new Error(`HTTP ${res.status}`)
    }
  }

  return {
    version,
    releases,
    hasMore,
    hasUnseen,
    popupOpen,
    popupEnabled,
    loading,
    error,
    evaluate,
    syncPopup,
    acknowledge,
    remindLater,
    markArchiveSeen,
    setPopupEnabled,
    loadPrefs,
  }
}
