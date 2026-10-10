import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  AudiobookshelfReconcileDirection,
} from '@bookorbit/types'
import {
  confirmAudiobookshelfMatch,
  fetchAudiobookshelfBookStates,
  linkAudiobookshelfBook,
  reconcileAudiobookshelfPosition,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
} from '@/features/audiobookshelf/api/audiobookshelf.api'
import { reconcileFailureKey } from '@/features/book/lib/abs-sync-status'

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_PAGE_SIZE = 10
const CHAIN = 'book.detail.editionLink.chain.'

export type AbsSyncBusy = AudiobookshelfReconcileDirection | 'retry' | 'resume' | 'pause' | 'confirm' | 'change'

/** The slice of useAudiobookshelfSyncLink the actions drive. */
export interface AudiobookshelfSyncHandle {
  link: Ref<AudiobookshelfBookSyncLink | null>
  live: Ref<AudiobookshelfBookSyncLive | null>
  refreshLive: () => Promise<void>
  applyLive: (status: AudiobookshelfBookSyncLive) => void
  reload: () => Promise<void>
}

/**
 * Everything the panel changes on the Audiobookshelf side: reconciling a position, pausing or resuming
 * the match's sync, confirming a match under review, and swapping the matched item for another.
 */
export function useAudiobookshelfSyncActions(sync: AudiobookshelfSyncHandle, audioBookId: () => number | null) {
  const { t } = useI18n()

  const busy = ref<AbsSyncBusy | null>(null)
  const actionError = ref<string | null>(null)

  function clearError(): void {
    actionError.value = null
  }

  async function reconcile(direction: AudiobookshelfReconcileDirection): Promise<void> {
    const link = sync.link.value
    if (!link || busy.value) return
    busy.value = direction
    actionError.value = null
    try {
      sync.applyLive(await reconcileAudiobookshelfPosition(link.absLibraryItemId, direction))
    } catch (error) {
      actionError.value = t(reconcileFailureKey(error))
    } finally {
      busy.value = null
    }
  }

  // Busy until the refresh settles, so the old status never reads as actionable again in between.
  async function retry(): Promise<void> {
    if (!sync.link.value || busy.value) return
    busy.value = 'retry'
    actionError.value = null
    try {
      await sync.refreshLive()
    } finally {
      busy.value = null
    }
  }

  async function runMatchChange(
    kind: AbsSyncBusy,
    change: (absLibraryItemId: string) => Promise<unknown>,
    successKey: () => string | null,
  ): Promise<boolean> {
    const link = sync.link.value
    if (!link || busy.value) return false
    busy.value = kind
    actionError.value = null
    try {
      await change(link.absLibraryItemId)
      await sync.reload()
      const key = successKey()
      if (key) toast.success(t(CHAIN + key))
      return true
    } catch {
      toast.error(t(`${CHAIN}toast.absFailed`))
      return false
    } finally {
      busy.value = null
    }
  }

  function resume(): Promise<boolean> {
    return runMatchChange(
      'resume',
      (id) => updateAudiobookshelfBookExclusion(id, false),
      () => 'toast.absResumed',
    )
  }

  /** Switching sync off only excludes the item; the match itself stays. */
  function pause(): Promise<boolean> {
    return runMatchChange(
      'pause',
      (id) => updateAudiobookshelfBookExclusion(id, true),
      () => 'toast.absPaused',
    )
  }

  function confirm(): Promise<boolean> {
    return runMatchChange('confirm', confirmAudiobookshelfMatch, () => (sync.link.value?.syncing ? 'toast.absResumed' : null))
  }

  const query = ref('')
  const results = ref<AudiobookshelfBookState[]>([])
  const searching = ref(false)
  const searchError = ref(false)
  const hasSearched = ref(false)
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchRequestId = 0

  async function runSearch(value: string, requestId: number): Promise<void> {
    try {
      const page = await fetchAudiobookshelfBookStates('unmatched', 0, SEARCH_PAGE_SIZE, value.trim() || undefined)
      if (requestId !== searchRequestId) return
      results.value = page.items
      searchError.value = false
    } catch {
      if (requestId !== searchRequestId) return
      results.value = []
      searchError.value = true
    } finally {
      if (requestId === searchRequestId) {
        searching.value = false
        hasSearched.value = true
      }
    }
  }

  function setQuery(value: string): void {
    query.value = value
    if (searchTimer) clearTimeout(searchTimer)
    const requestId = ++searchRequestId
    searching.value = true
    searchTimer = setTimeout(() => {
      searchTimer = null
      void runSearch(value, requestId)
    }, SEARCH_DEBOUNCE_MS)
  }

  function resetSearch(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
    searchRequestId += 1
    query.value = ''
    results.value = []
    searching.value = false
    searchError.value = false
    hasSearched.value = false
  }

  // The previous item is unmatched before the new one is linked. If linking then fails, the previous one is
  // linked again on a best-effort basis, so a failure normally leaves the book where it started.
  async function change(item: AudiobookshelfBookState): Promise<boolean> {
    const bookId = audioBookId()
    const previous = sync.link.value?.absLibraryItemId ?? null
    if (bookId === null || busy.value) return false
    busy.value = 'change'
    actionError.value = null
    const swapped = previous !== null && previous !== item.absLibraryItemId
    let unlinked = false
    let succeeded = false
    try {
      if (swapped) {
        await unlinkAudiobookshelfBook(previous)
        unlinked = true
      }
      await linkAudiobookshelfBook(item.absLibraryItemId, bookId)
      succeeded = true
    } catch {
      if (unlinked && previous) await linkAudiobookshelfBook(previous, bookId).catch(() => undefined)
    }
    try {
      await sync.reload()
    } catch {
      // The change itself went through; the next open reads the match again.
    }
    busy.value = null
    if (succeeded) {
      resetSearch()
      toast.success(t(`${CHAIN}toast.absChanged`))
    } else {
      toast.error(t(`${CHAIN}toast.absFailed`))
    }
    return succeeded
  }

  return {
    busy,
    actionError,
    clearError,
    reconcile,
    retry,
    resume,
    pause,
    confirm,
    change,
    search: { query, results, searching, searchError, hasSearched, setQuery, reset: resetSearch },
  }
}
