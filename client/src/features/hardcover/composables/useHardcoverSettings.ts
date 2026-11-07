import { onSessionCleared } from '@/lib/session-reset'
import { createCachedRequest } from '@/lib/cached-request'
import { ref } from 'vue'
import type { HardcoverSettings, UpsertHardcoverSettingsPayload } from '@bookorbit/types'
import { disconnectHardcover, fetchHardcoverSettings, upsertHardcoverSettings, validateHardcoverToken } from '../api/hardcover.api'

const settings = ref<HardcoverSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const validating = ref(false)
const error = ref<string | null>(null)

const settingsRequest = createCachedRequest(loadSettings)
export function invalidateHardcoverSettings() {
  settingsRequest.invalidate()
}

async function loadSettings(isCurrent: () => boolean): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const nextSettings = await fetchHardcoverSettings()
    if (isCurrent()) settings.value = nextSettings
  } catch (err) {
    if (isCurrent()) {
      loading.value = false
      settingsRequest.invalidate()
      error.value = err instanceof Error ? err.message : 'Failed to load settings'
    }
  } finally {
    if (isCurrent()) loading.value = false
  }
}

export function resetHardcoverSettings() {
  invalidateHardcoverSettings()
  loading.value = false
  error.value = null
  settings.value = null
}

onSessionCleared(resetHardcoverSettings)

export function useHardcoverSettings() {
  function fetchSettings(options: { force?: boolean } = {}): Promise<void> {
    return settingsRequest.get(options)
  }

  async function saveSettings(payload: UpsertHardcoverSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await upsertHardcoverSettings(payload)
      invalidateHardcoverSettings()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save settings'
      return false
    } finally {
      saving.value = false
    }
  }

  async function disconnect(): Promise<void> {
    saving.value = true
    error.value = null
    try {
      await disconnectHardcover()
      settings.value = null
      invalidateHardcoverSettings()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to disconnect'
    } finally {
      saving.value = false
    }
  }

  async function validateToken(token?: string): Promise<{ valid: boolean; username?: string }> {
    validating.value = true
    try {
      const result = await validateHardcoverToken(token)
      return { valid: result.valid, username: result.hardcoverUsername }
    } catch {
      return { valid: false }
    } finally {
      validating.value = false
    }
  }

  return {
    settings,
    loading,
    saving,
    validating,
    error,
    fetchSettings,
    saveSettings,
    disconnect,
    validateToken,
  }
}
