import { invalidateEditionSyncSettings } from './useEditionSyncSettings'
import { computed, inject, onScopeDispose, provide, ref, watch, type InjectionKey } from 'vue'
import type { EditionSyncAdminSettings, EditionSyncAdminStatus, UpdateEditionSyncAdminSettingsPayload } from '@bookorbit/types'
import { followJobType } from '@/features/jobs/lib/follow-job-type'
import {
  clearUnusedEditionSyncData,
  fetchEditionSyncAdminSettings,
  fetchEditionSyncAdminStatus,
  startEditionSyncRun,
  stopEditionSyncRun,
  updateEditionSyncAdminSettings,
} from '../api/edition-sync.api'

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
  const runActive = computed(() => status.value?.run.active === true)
  let stopFollowing: (() => void) | null = null
  let disposed = false

  function unfollow(): void {
    stopFollowing?.()
    stopFollowing = null
  }

  function isRunActive(): boolean {
    return runActive.value
  }

  async function refreshStatus(): Promise<void> {
    try {
      status.value = await fetchEditionSyncAdminStatus()
    } catch (err) {
      error.value = messageOf(err)
    }
  }

  /** While a run is active, the Jobs push for edition sync keeps the status current. */
  function followWhileActive(): void {
    if (disposed || !runActive.value) return unfollow()
    stopFollowing ??= followJobType('edition-sync', refreshStatus, isRunActive)
  }

  watch(runActive, followWhileActive)

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
      followWhileActive()
    }
  }

  async function saveSchedule(payload: UpdateEditionSyncAdminSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await updateEditionSyncAdminSettings(payload)
      invalidateEditionSyncSettings()
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
      followWhileActive()
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
    unfollow()
  })

  return { status, settings, loading, saving, acting, error, runActive, load, refreshStatus, saveSchedule, runNow, stop, clearUnused }
}

export type EditionSyncAdmin = ReturnType<typeof useEditionSyncAdmin>

/** One admin state per page, so the Indexing card and the Server section share a single status follow. */
export const EDITION_SYNC_ADMIN_KEY: InjectionKey<EditionSyncAdmin> = Symbol('editionSyncAdmin')

export function provideEditionSyncAdmin(): EditionSyncAdmin {
  const admin = useEditionSyncAdmin()
  provide(EDITION_SYNC_ADMIN_KEY, admin)
  return admin
}

export function injectEditionSyncAdmin(): EditionSyncAdmin {
  const admin = inject(EDITION_SYNC_ADMIN_KEY, null)
  if (!admin) throw new Error('injectEditionSyncAdmin() needs provideEditionSyncAdmin() in an ancestor')
  return admin
}
