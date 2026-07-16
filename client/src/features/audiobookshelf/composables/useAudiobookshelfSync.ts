import { computed, ref } from 'vue'
import { startAudiobookshelfFullResync, startAudiobookshelfSync, type AudiobookshelfSyncResult } from '../api/audiobookshelf.api'
import { useAudiobookshelfSettings } from './useAudiobookshelfSettings'

const syncing = ref(false)
const syncMode = ref<'incremental' | 'full' | null>(null)
const lastResult = ref<AudiobookshelfSyncResult | null>(null)
const error = ref<string | null>(null)

const isFullResync = computed(() => syncing.value && syncMode.value === 'full')

export function useAudiobookshelfSync() {
  async function run(mode: 'incremental' | 'full'): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    syncMode.value = mode
    error.value = null
    lastResult.value = null
    try {
      lastResult.value = mode === 'full' ? await startAudiobookshelfFullResync() : await startAudiobookshelfSync()
      await useAudiobookshelfSettings().fetchSettings()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to sync Audiobookshelf'
      await useAudiobookshelfSettings().fetchSettings()
      return false
    } finally {
      syncing.value = false
      syncMode.value = null
    }
  }

  async function syncNow(): Promise<boolean> {
    return run('incremental')
  }

  async function fullResync(): Promise<boolean> {
    return run('full')
  }

  return { syncing, syncMode, lastResult, error, isFullResync, syncNow, fullResync }
}
