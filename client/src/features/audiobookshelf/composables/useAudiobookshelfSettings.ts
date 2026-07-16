import { ref } from 'vue'
import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfSettings,
  testAudiobookshelfConnection,
  updateAudiobookshelfSettings,
  type AudiobookshelfConnectionTestResult,
  type AudiobookshelfSettingsResponse,
  type TestAudiobookshelfConnectionRequest,
  type UpdateAudiobookshelfSettingsRequest,
} from '../api/audiobookshelf.api'

const settings = ref<AudiobookshelfSettingsResponse | null>(null)
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

  async function saveSettings(payload: UpdateAudiobookshelfSettingsRequest): Promise<boolean> {
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

  async function testConnection(payload: TestAudiobookshelfConnectionRequest): Promise<AudiobookshelfConnectionTestResult> {
    testing.value = true
    error.value = null
    try {
      return await testAudiobookshelfConnection(payload)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to test Audiobookshelf connection'
      return { valid: false }
    } finally {
      testing.value = false
    }
  }

  return { settings, loading, saving, testing, error, fetchSettings, saveSettings, disconnect, testConnection }
}
