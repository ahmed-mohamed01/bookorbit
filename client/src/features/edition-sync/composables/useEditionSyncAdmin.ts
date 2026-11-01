import { onScopeDispose, ref } from 'vue'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus, UpdateEditionSyncAdminSettingsPayload } from '@bookorbit/types'
import {
  clearUnusedEditionSyncData,
  fetchEditionSyncAdminSettings,
  fetchEditionSyncAdminStatus,
  startEditionSyncRun,
  stopEditionSyncRun,
  updateEditionSyncAdminSettings,
} from '../api/edition-sync.api'

export const EDITION_SYNC_ADMIN_POLL_MS = 5_000

function messageOf(err: unknown): string | null {
  return err instanceof Error && err.message ? err.message : null
}

export function useEditionSyncAdmin() {
  const status = ref<EditionSyncAdminStatus | null>(null)
  const settings = ref<EditionSyncAdminSettings | null>(null)
  const loading = ref(true)
  const saving = ref(false)
  const acting = ref(false)
  const error = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  async function refreshStatus(): Promise<void> {
    try {
      status.value = await fetchEditionSyncAdminStatus()
    } catch (err) {
      error.value = messageOf(err)
    }
  }

  function schedulePoll(): void {
    stopPolling()
    if (disposed || status.value?.run.active !== true) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void refreshStatus().finally(schedulePoll)
    }, EDITION_SYNC_ADMIN_POLL_MS)
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [nextSettings, nextStatus] = await Promise.all([fetchEditionSyncAdminSettings(), fetchEditionSyncAdminStatus()])
      settings.value = nextSettings
      status.value = nextStatus
    } catch (err) {
      error.value = messageOf(err)
    } finally {
      loading.value = false
      schedulePoll()
    }
  }

  async function saveSchedule(payload: UpdateEditionSyncAdminSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await updateEditionSyncAdminSettings(payload)
      await refreshStatus()
      return true
    } catch (err) {
      error.value = messageOf(err)
      return false
    } finally {
      saving.value = false
    }
  }

  async function control(call: () => Promise<EditionSyncAdminStatus>): Promise<boolean> {
    acting.value = true
    error.value = null
    try {
      status.value = await call()
      schedulePoll()
      return true
    } catch (err) {
      error.value = messageOf(err)
      return false
    } finally {
      acting.value = false
    }
  }

  function runNow(): Promise<boolean> {
    return control(startEditionSyncRun)
  }

  function stop(): Promise<boolean> {
    return control(stopEditionSyncRun)
  }

  async function clearUnused(): Promise<{ deleted: number; freedBytes: number } | null> {
    acting.value = true
    error.value = null
    try {
      const result = await clearUnusedEditionSyncData()
      await refreshStatus()
      return result
    } catch (err) {
      error.value = messageOf(err)
      return null
    } finally {
      acting.value = false
    }
  }

  onScopeDispose(() => {
    disposed = true
    stopPolling()
  })

  return { status, settings, loading, saving, acting, error, load, refreshStatus, saveSchedule, runNow, stop, clearUnused }
}
