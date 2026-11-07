import { onSessionCleared } from '@/lib/session-reset'
import { createCachedRequest } from '@/lib/cached-request'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import type { EditionSyncSettings, UpsertEditionSyncSettingsPayload } from '@bookorbit/types'
import { fetchEditionSyncSettings, updateEditionSyncSettings } from '../api/edition-sync.api'

const settings = ref<EditionSyncSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

function messageOf(err: unknown, fallbackKey: string): string {
  return err instanceof Error && err.message ? err.message : i18n.global.t(fallbackKey)
}

const settingsRequest = createCachedRequest(loadSettings)
export function invalidateEditionSyncSettings() {
  settingsRequest.invalidate()
}

async function loadSettings(isCurrent: () => boolean): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const nextSettings = await fetchEditionSyncSettings()
    if (isCurrent()) settings.value = nextSettings
  } catch (err) {
    if (isCurrent()) {
      loading.value = false
      settingsRequest.invalidate()
      settings.value = null
      error.value = messageOf(err, 'editionSync.errors.settingsLoadFailed')
    }
  } finally {
    if (isCurrent()) loading.value = false
  }
}

export function resetEditionSyncSettings() {
  invalidateEditionSyncSettings()
  loading.value = false
  error.value = null
  settings.value = null
}

onSessionCleared(resetEditionSyncSettings)

export function useEditionSyncSettings() {
  function fetchSettings(options: { force?: boolean } = {}): Promise<void> {
    return settingsRequest.get(options)
  }

  async function saveSettings(payload: UpsertEditionSyncSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await updateEditionSyncSettings(payload)
      invalidateEditionSyncSettings()
      return true
    } catch (err) {
      error.value = messageOf(err, 'editionSync.user.toast.saveFailed')
      return false
    } finally {
      saving.value = false
    }
  }

  return { settings, loading, saving, error, fetchSettings, saveSettings }
}
