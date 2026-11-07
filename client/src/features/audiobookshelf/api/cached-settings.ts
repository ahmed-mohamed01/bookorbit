import { onSessionCleared } from '@/lib/session-reset'
import { ref } from 'vue'
import type { AudiobookshelfSettings } from '@bookorbit/types'
import { createCachedRequest } from '@/lib/cached-request'
import { fetchAudiobookshelfSettings } from './audiobookshelf.api'

export const audiobookshelfSettings = ref<AudiobookshelfSettings | null>(null)
export const audiobookshelfSettingsError = ref<string | null>(null)
export const audiobookshelfSettingsRequest = createCachedRequest(async (isCurrent) => {
  audiobookshelfSettingsError.value = null
  try {
    const settings = await fetchAudiobookshelfSettings()
    if (isCurrent()) audiobookshelfSettings.value = settings
    return settings
  } catch (err) {
    if (isCurrent()) audiobookshelfSettingsError.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf settings'
    throw err
  }
})
export function invalidateAudiobookshelfSyncSettings() {
  audiobookshelfSettingsRequest.invalidate()
}
export function resetAudiobookshelfSettings() {
  invalidateAudiobookshelfSyncSettings()
  audiobookshelfSettingsError.value = null
  audiobookshelfSettings.value = null
}

onSessionCleared(resetAudiobookshelfSettings)
