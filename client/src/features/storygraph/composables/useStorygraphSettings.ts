import { onSessionCleared } from '@/lib/session-reset'
import { createCachedRequest } from '@/lib/cached-request'
import { ref } from 'vue'
import type { StorygraphSettings, UpsertStorygraphSettingsPayload } from '@bookorbit/types'
import { disconnectStorygraph, fetchStorygraphSettings, upsertStorygraphSettings, validateStorygraphCookies } from '../api/storygraph.api'

const settings = ref<StorygraphSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const validating = ref(false)
const error = ref<string | null>(null)

const settingsRequest = createCachedRequest(loadSettings)
export function invalidateStorygraphSettings() {
  settingsRequest.invalidate()
}

async function loadSettings(isCurrent: () => boolean): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const nextSettings = await fetchStorygraphSettings()
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

export function resetStorygraphSettings() {
  invalidateStorygraphSettings()
  loading.value = false
  error.value = null
  settings.value = null
}

onSessionCleared(resetStorygraphSettings)

export function useStorygraphSettings() {
  function fetchSettings(options: { force?: boolean } = {}): Promise<void> {
    return settingsRequest.get(options)
  }

  async function saveSettings(payload: UpsertStorygraphSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await upsertStorygraphSettings(payload)
      invalidateStorygraphSettings()
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
      await disconnectStorygraph()
      settings.value = null
      invalidateStorygraphSettings()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to disconnect'
    } finally {
      saving.value = false
    }
  }

  async function validateCookies(sessionCookie?: string, rememberToken?: string): Promise<{ valid: boolean }> {
    validating.value = true
    try {
      const result = await validateStorygraphCookies(sessionCookie, rememberToken)
      return { valid: result.valid }
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
    validateCookies,
  }
}
