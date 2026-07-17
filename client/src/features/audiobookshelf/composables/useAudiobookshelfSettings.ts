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
let nextSettingsRequestId = 0
let settingsMutationGeneration = 0
let activeSettingsSaveId = 0
let activeSettingsFetch: {
  promise: Promise<void>
  requestId: number
  mutationGeneration: number
  canCommit: boolean
} | null = null
let settingsMutationQueue: Promise<unknown> | null = null
let pendingCredentialDiscovery = false
let nextLibraryRequestId = 0
let currentLibraryRequestId = 0
let activeLibraryFetch: {
  promise: Promise<void>
  requestId: number
} | null = null

interface FetchLibrariesOptions {
  forceFresh?: boolean
}

function clearStaleSettingsFetch(): void {
  if (activeSettingsFetch && (!activeSettingsFetch.canCommit || activeSettingsFetch.mutationGeneration !== settingsMutationGeneration)) {
    activeSettingsFetch = null
    loading.value = false
  }
}

function queueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = settingsMutationQueue ? settingsMutationQueue.catch(() => undefined).then(operation) : operation()
  const tracked = queued.catch(() => undefined)
  settingsMutationQueue = tracked
  void tracked.finally(() => {
    if (settingsMutationQueue === tracked) {
      settingsMutationQueue = null
    }
  })
  return queued
}

export function useAudiobookshelfSettings() {
  async function fetchSettings(): Promise<void> {
    if (
      activeSettingsFetch &&
      activeSettingsFetch.mutationGeneration === settingsMutationGeneration &&
      activeSettingsFetch.canCommit &&
      activeSettingsSaveId === 0
    ) {
      return activeSettingsFetch.promise
    }
    const requestId = ++nextSettingsRequestId
    const mutationGeneration = settingsMutationGeneration
    const canCommit = activeSettingsSaveId === 0
    loading.value = true
    error.value = null
    const promise = (async () => {
      try {
        const nextSettings = await fetchAudiobookshelfSettings()
        if (canCommit && mutationGeneration === settingsMutationGeneration && activeSettingsSaveId === 0) {
          settings.value = nextSettings
        }
      } catch (err) {
        if (
          canCommit &&
          activeSettingsFetch?.requestId === requestId &&
          mutationGeneration === settingsMutationGeneration &&
          activeSettingsSaveId === 0
        ) {
          error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf settings'
        }
      } finally {
        if (activeSettingsFetch?.requestId === requestId) {
          activeSettingsFetch = null
          loading.value = false
        }
      }
    })()
    activeSettingsFetch = { promise, requestId, mutationGeneration, canCommit }
    return promise
  }

  async function saveSettings(payload: UpsertAudiobookshelfSettingsPayload): Promise<boolean> {
    const saveId = ++nextSettingsRequestId
    activeSettingsSaveId = saveId
    settingsMutationGeneration += 1
    if (payload.serverUrl || payload.apiToken) {
      pendingCredentialDiscovery = true
    }
    saving.value = true
    error.value = null
    return queueSettingsMutation(async () => {
      try {
        const nextSettings = await updateAudiobookshelfSettings(payload)
        if (activeSettingsSaveId === saveId) {
          settings.value = nextSettings
          clearStaleSettingsFetch()
        }
        if (activeSettingsSaveId === saveId && pendingCredentialDiscovery && nextSettings.serverUrl && nextSettings.tokenConfigured) {
          await fetchLibraries({ forceFresh: true }).catch(() => undefined)
          if (activeSettingsSaveId === saveId && librariesError.value === null) {
            pendingCredentialDiscovery = false
          }
        }
        return true
      } catch (err) {
        if (activeSettingsSaveId === saveId) {
          error.value = err instanceof Error ? err.message : 'Failed to save Audiobookshelf settings'
        }
        return false
      } finally {
        if (activeSettingsSaveId === saveId) {
          activeSettingsSaveId = 0
          saving.value = false
        }
      }
    })
  }

  async function fetchLibraries(options: FetchLibrariesOptions = {}): Promise<void> {
    if (!options.forceFresh && activeLibraryFetch?.requestId === currentLibraryRequestId) {
      return activeLibraryFetch.promise
    }
    const requestId = ++nextLibraryRequestId
    currentLibraryRequestId = requestId
    librariesLoading.value = true
    librariesError.value = null
    const promise = (async () => {
      try {
        const nextLibraries = await fetchAudiobookshelfLibraries()
        if (currentLibraryRequestId === requestId) {
          libraries.value = nextLibraries.libraries
        }
      } catch (err) {
        if (currentLibraryRequestId === requestId) {
          librariesError.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf libraries'
        }
      } finally {
        if (currentLibraryRequestId === requestId) {
          librariesLoading.value = false
        }
        if (activeLibraryFetch?.requestId === requestId) {
          activeLibraryFetch = null
        }
      }
    })()
    activeLibraryFetch = { promise, requestId }
    return promise
  }

  async function disconnect(): Promise<boolean> {
    const saveId = ++nextSettingsRequestId
    activeSettingsSaveId = saveId
    settingsMutationGeneration += 1
    saving.value = true
    error.value = null
    currentLibraryRequestId = ++nextLibraryRequestId
    activeLibraryFetch = null
    librariesLoading.value = false
    librariesError.value = null
    return queueSettingsMutation(async () => {
      try {
        await disconnectAudiobookshelf()
        if (activeSettingsSaveId === saveId) {
          pendingCredentialDiscovery = false
          settings.value = null
          clearStaleSettingsFetch()
          libraries.value = []
          librariesLoading.value = false
          librariesError.value = null
        }
        return true
      } catch (err) {
        if (activeSettingsSaveId === saveId) {
          error.value = err instanceof Error ? err.message : 'Failed to disconnect Audiobookshelf'
        }
        return false
      } finally {
        if (activeSettingsSaveId === saveId) {
          activeSettingsSaveId = 0
          saving.value = false
          activeLibraryFetch = null
        }
      }
    })
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
