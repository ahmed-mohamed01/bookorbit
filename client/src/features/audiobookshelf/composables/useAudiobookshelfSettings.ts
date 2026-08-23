import { ref } from 'vue'
import type {
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrary,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfSettings,
  testAudiobookshelfConnection,
  updateAudiobookshelfSettings,
} from '../api/audiobookshelf.api'

const settings = ref<AudiobookshelfSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)
const testError = ref<string | null>(null)
const libraries = ref<AudiobookshelfLibrary[]>([])
const librariesLoading = ref(false)
const librariesError = ref<string | null>(null)

let currentLibraryRequestId = 0

export function useAudiobookshelfSettings() {
  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await fetchAudiobookshelfSettings()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf settings'
    } finally {
      loading.value = false
    }
  }

  async function fetchLibraries(): Promise<void> {
    const requestId = ++currentLibraryRequestId
    librariesLoading.value = true
    librariesError.value = null
    try {
      const nextLibraries = await fetchAudiobookshelfLibraries()
      if (requestId === currentLibraryRequestId) libraries.value = nextLibraries.libraries
    } catch (err) {
      if (requestId === currentLibraryRequestId) {
        librariesError.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf libraries'
      }
    } finally {
      if (requestId === currentLibraryRequestId) librariesLoading.value = false
    }
  }

  async function saveSettings(payload: UpsertAudiobookshelfSettingsPayload): Promise<boolean> {
    const credentialsChanged = Boolean(payload.serverUrl || payload.apiToken)
    saving.value = true
    error.value = null
    try {
      const nextSettings = await updateAudiobookshelfSettings(payload)
      settings.value = nextSettings
      if (credentialsChanged && nextSettings.serverUrl && nextSettings.tokenConfigured) {
        await fetchLibraries()
      }
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save Audiobookshelf settings'
      return false
    } finally {
      saving.value = false
    }
  }

  async function disconnect(): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      await disconnectAudiobookshelf()
      settings.value = null
      currentLibraryRequestId++
      libraries.value = []
      librariesLoading.value = false
      librariesError.value = null
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to disconnect Audiobookshelf'
      return false
    } finally {
      saving.value = false
    }
  }

  async function testConnection(payload: AudiobookshelfConnectionTestPayload): Promise<AudiobookshelfConnectionTestResult> {
    if (saving.value) {
      testError.value = 'Wait for the current Audiobookshelf settings change to finish'
      return { success: false, error: testError.value }
    }
    testing.value = true
    testError.value = null
    try {
      return await testAudiobookshelfConnection(payload)
    } catch (err) {
      testError.value = err instanceof Error ? err.message : 'Failed to test Audiobookshelf connection'
      return { success: false, error: testError.value ?? undefined }
    } finally {
      testing.value = false
    }
  }

  return {
    settings,
    loading,
    saving,
    testing,
    error,
    testError,
    libraries,
    librariesLoading,
    librariesError,
    fetchSettings,
    fetchLibraries,
    saveSettings,
    disconnect,
    testConnection,
  }
}
