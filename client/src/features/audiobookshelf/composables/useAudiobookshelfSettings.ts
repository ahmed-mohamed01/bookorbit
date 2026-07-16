import { ref } from 'vue'
import type {
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfConnectionTestResult,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfSettings,
  testAudiobookshelfConnection,
  updateAudiobookshelfSettings,
} from '../api/audiobookshelf.api'

const settings = ref<AudiobookshelfSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)

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

  async function saveSettings(payload: UpsertAudiobookshelfSettingsPayload): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      settings.value = await updateAudiobookshelfSettings(payload)
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
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to disconnect Audiobookshelf'
      return false
    } finally {
      saving.value = false
    }
  }

  async function testConnection(payload: AudiobookshelfConnectionTestPayload): Promise<AudiobookshelfConnectionTestResult> {
    testing.value = true
    error.value = null
    try {
      return await testAudiobookshelfConnection(payload)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to test Audiobookshelf connection'
      return { success: false, error: error.value ?? undefined }
    } finally {
      testing.value = false
    }
  }

  return { settings, loading, saving, testing, error, fetchSettings, saveSettings, disconnect, testConnection }
}
