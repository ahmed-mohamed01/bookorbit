import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { Permission, type EditionSyncBookState } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { i18n } from '@/i18n'
import { fetchEditionSyncBookState, retryEditionSyncBook, runEditionSyncBookNow, updateEditionSyncBookState } from '../api/edition-sync.api'
import { useEditionSyncSettings } from './useEditionSyncSettings'

export const EDITION_SYNC_POLL_MS = 10_000
export const EDITION_SYNC_QUEUED_POLL_MS = 60_000

function messageOf(err: unknown, fallbackKey: string): string {
  return err instanceof Error && err.message ? err.message : i18n.global.t(fallbackKey)
}

export function useEditionSyncBookState(bookId: Ref<number>, filesKey?: () => string) {
  const { hasPermission } = usePermissions()
  const { settings, fetchSettings } = useEditionSyncSettings()

  const state = ref<EditionSyncBookState | null>(null)
  const settingsLoaded = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const acting = ref(false)
  const error = ref<string | null>(null)
  let settingsRequestId = 0
  let stateRequestId = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const allowed = computed(() => hasPermission(Permission.EditionSync))
  const visible = computed(() => allowed.value && settingsLoaded.value && settings.value?.effectiveEnabled === true)
  const syncEnabled = computed(() => state.value?.syncEnabled === true)
  const editionCount = computed(() => state.value?.editionCount ?? 2)
  const eligible = computed(() => state.value?.eligible !== false)
  const busy = computed(() => loading.value || saving.value || acting.value)
  const polling = computed(() => syncEnabled.value && ['running', 'queued', 'stale'].includes(state.value?.index.status ?? ''))
  const pollDelay = computed(() => {
    const current = state.value
    if (current?.index.status === 'queued' && !current.pinned && !current.runActive) return EDITION_SYNC_QUEUED_POLL_MS
    return EDITION_SYNC_POLL_MS
  })

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  async function refresh(): Promise<void> {
    const targetBookId = bookId.value
    const requestId = ++stateRequestId
    try {
      const next = await fetchEditionSyncBookState(targetBookId)
      if (!disposed && requestId === stateRequestId && bookId.value === targetBookId) state.value = next
    } catch {
      // A failed poll keeps the last known state; the next tick retries.
    }
  }

  function schedulePoll(): void {
    stopPolling()
    if (disposed || !polling.value) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void refresh().finally(schedulePoll)
    }, pollDelay.value)
  }

  watch(polling, schedulePoll)
  watch(state, schedulePoll)
  if (filesKey) {
    watch(filesKey, () => {
      if (visible.value) void refresh()
    })
  }
  onScopeDispose(() => {
    disposed = true
    stopPolling()
  })

  watch(
    allowed,
    async (isAllowed) => {
      const requestId = ++settingsRequestId
      settingsLoaded.value = false
      if (!isAllowed) return
      await fetchSettings()
      if (requestId === settingsRequestId) settingsLoaded.value = true
    },
    { immediate: true },
  )

  watch(
    [bookId, visible],
    async ([currentBookId, isVisible]) => {
      const requestId = ++stateRequestId
      state.value = null
      error.value = null
      if (!isVisible) {
        loading.value = false
        return
      }
      loading.value = true
      try {
        const next = await fetchEditionSyncBookState(currentBookId)
        if (requestId === stateRequestId) state.value = next
      } catch {
        if (requestId === stateRequestId) error.value = i18n.global.t('editionSync.errors.loadFailed')
      } finally {
        if (requestId === stateRequestId) loading.value = false
      }
    },
    { immediate: true },
  )

  async function act(call: (id: number) => Promise<EditionSyncBookState>, failureKey: string): Promise<void> {
    if (!visible.value || acting.value) return
    const targetBookId = bookId.value
    const requestId = ++stateRequestId
    acting.value = true
    error.value = null
    try {
      const next = await call(targetBookId)
      if (requestId === stateRequestId && bookId.value === targetBookId) state.value = next
    } catch (err) {
      if (bookId.value === targetBookId) error.value = messageOf(err, failureKey)
    } finally {
      acting.value = false
    }
  }

  async function setSyncEnabled(value: boolean): Promise<boolean> {
    if (!visible.value || saving.value) return false
    const targetBookId = bookId.value
    const previous = state.value
    const requestId = ++stateRequestId
    saving.value = true
    error.value = null
    try {
      const next = await updateEditionSyncBookState(targetBookId, { syncEnabled: value })
      if (requestId === stateRequestId && bookId.value === targetBookId) state.value = next
      return true
    } catch (err) {
      if (bookId.value === targetBookId) {
        if (requestId === stateRequestId) state.value = previous
        error.value = messageOf(err, 'editionSync.errors.saveFailed')
      }
      return false
    } finally {
      saving.value = false
    }
  }

  function runNow(): Promise<void> {
    return act(runEditionSyncBookNow, 'editionSync.errors.runFailed')
  }

  function retry(): Promise<void> {
    return act(retryEditionSyncBook, 'editionSync.errors.retryFailed')
  }

  return { state, visible, syncEnabled, editionCount, eligible, busy, saving, acting, error, setSyncEnabled, runNow, retry, refresh }
}
