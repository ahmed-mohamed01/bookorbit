import { ref, watch, type Ref } from 'vue'
import { Permission, type AudiobookshelfBookSyncLink, type AudiobookshelfBookSyncLive } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { fetchAudiobookshelfSyncLink, fetchAudiobookshelfSyncLive } from '@/features/audiobookshelf/api/audiobookshelf.api'

// A live check that fails still has to leave the stop with a way to act, which the unreachable state offers.
const UNREACHABLE: AudiobookshelfBookSyncLive = { status: 'unreachable', progress: null, local: null, divergedReason: null }

/**
 * The Audiobookshelf item an audiobook's position syncs with, or null when there is none to show:
 * no permission, sync switched off, no match, or no position sync in either direction. The link comes
 * from BookOrbit alone so it renders with the other editions; the live status follows from
 * Audiobookshelf itself.
 */
export type AudiobookshelfSyncLinkState = Pick<ReturnType<typeof useAudiobookshelfSyncLink>, 'link' | 'live' | 'checking'>

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

  async function load(bookId: number | null) {
    const current = ++requestId
    link.value = null
    live.value = null
    checking.value = false
    if (bookId === null || !hasPermission(Permission.AudiobookshelfSync)) return
    let found: AudiobookshelfBookSyncLink | null
    try {
      found = await fetchAudiobookshelfSyncLink(bookId)
    } catch {
      if (current === requestId) link.value = null
      return
    }
    if (current !== requestId) return
    link.value = found
    if (found) await loadLive(current, found.absLibraryItemId)
  }

  function refreshLive() {
    if (link.value) void loadLive(requestId, link.value.absLibraryItemId)
  }

  /** Takes a status the server already answered with, such as a reconcile's, instead of asking again. */
  function applyLive(status: AudiobookshelfBookSyncLive) {
    if (!link.value) return
    live.value = status
    checking.value = false
  }

  watch(audioBookId, (bookId) => void load(bookId), { immediate: true })

  return { link, live, checking, refreshLive, applyLive }
}
