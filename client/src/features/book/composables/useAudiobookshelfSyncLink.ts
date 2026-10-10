import { ref, watch, type Ref } from 'vue'
import { Permission, type AudiobookshelfBookSyncLink, type AudiobookshelfBookSyncLive } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { fetchAudiobookshelfSyncLink, fetchAudiobookshelfSyncLive } from '@/features/audiobookshelf/api/audiobookshelf.api'

// A live check that fails still has to leave the sync chain with a way to act, which the unreachable state offers.
const UNREACHABLE: AudiobookshelfBookSyncLive = { status: 'unreachable', progress: null, local: null, divergedReason: null }

/**
 * The Audiobookshelf item an audiobook is matched with, or null when there is none to show: no
 * permission or no match. A paused match is returned too (`syncing` false, with its reason), so the
 * panel can offer to resume it. The link comes from BookOrbit alone so it renders with the other
 * editions; the live status follows from Audiobookshelf itself, and only for a match that syncs.
 */
export function useAudiobookshelfSyncLink(audioBookId: Ref<number | null>) {
  const { hasPermission } = usePermissions()
  const link = ref<AudiobookshelfBookSyncLink | null>(null)
  const live = ref<AudiobookshelfBookSyncLive | null>(null)
  const checking = ref(false)
  let requestId = 0

  async function loadLive(current: number, absLibraryItemId: string) {
    // A refresh keeps the last known status on screen; only a first check shows the shimmer.
    checking.value = live.value === null
    let status: AudiobookshelfBookSyncLive
    try {
      status = await fetchAudiobookshelfSyncLive(absLibraryItemId)
    } catch {
      // A fresh object each time, so a retry that fails again still reads as a new answer.
      status = { ...UNREACHABLE }
    }
    if (current !== requestId) return
    live.value = status
    checking.value = false
  }

  // A reload after a change made here keeps the current match on screen until the new answer lands.
  async function load(bookId: number | null, keepCurrent = false) {
    const current = ++requestId
    if (!keepCurrent) {
      link.value = null
      live.value = null
      checking.value = false
    }
    if (bookId === null || !hasPermission(Permission.AudiobookshelfSync)) {
      link.value = null
      live.value = null
      return
    }
    let found: AudiobookshelfBookSyncLink | null
    try {
      found = await fetchAudiobookshelfSyncLink(bookId)
    } catch {
      if (current === requestId) link.value = null
      return
    }
    if (current !== requestId) return
    if (found?.absLibraryItemId !== link.value?.absLibraryItemId) live.value = null
    link.value = found
    if (found?.syncing) await loadLive(current, found.absLibraryItemId)
    else {
      live.value = null
      checking.value = false
    }
  }

  function refreshLive(): Promise<void> {
    return link.value?.syncing ? loadLive(requestId, link.value.absLibraryItemId) : Promise.resolve()
  }

  /** Takes a status the server already answered with, such as a reconcile's, instead of asking again. */
  function applyLive(status: AudiobookshelfBookSyncLive) {
    if (!link.value) return
    live.value = status
    checking.value = false
  }

  /** Reads the match again for the current audiobook, after a pause, resume, confirm or change. */
  function reload(): Promise<void> {
    return load(audioBookId.value, true)
  }

  watch(audioBookId, (bookId) => void load(bookId), { immediate: true })

  return { link, live, checking, refreshLive, applyLive, reload }
}
