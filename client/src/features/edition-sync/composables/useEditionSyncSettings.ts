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

export function useEditionSyncSettings() {
  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await fetchEditionSyncSettings()
    } catch (err) {
      settings.value = null
      error.value = messageOf(err, 'editionSync.errors.settingsLoadFailed')
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(payload: UpsertEditionSyncSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await updateEditionSyncSettings(payload)
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
