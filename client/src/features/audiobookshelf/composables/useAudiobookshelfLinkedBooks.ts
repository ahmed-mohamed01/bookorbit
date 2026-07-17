import { reactive, ref } from 'vue'
import {
  confirmAudiobookshelfMatch,
  fetchAudiobookshelfBookStates,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
  type AudiobookshelfBookStatePage,
  type AudiobookshelfBookStateBucket,
} from '../api/audiobookshelf.api'

const PAGE_SIZE = 20

function emptyPage(): AudiobookshelfBookStatePage {
  return { items: [], total: 0, page: 0, pageSize: PAGE_SIZE }
}

const pages = reactive<Record<AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage>>({
  linked: emptyPage(),
  'needs-review': emptyPage(),
  unmatched: emptyPage(),
})
const loading = ref(false)
const rescanning = ref(false)
const error = ref<string | null>(null)
const actionId = ref<string | null>(null)
let loadRequestId = 0

function beginLoad(): number {
  const requestId = ++loadRequestId
  loading.value = true
  error.value = null
  return requestId
}

function isCurrentLoad(requestId: number): boolean {
  return requestId === loadRequestId
}

export function useAudiobookshelfLinkedBooks() {
  async function loadBucket(bucket: AudiobookshelfBookStateBucket, page = pages[bucket].page): Promise<void> {
    const requestId = beginLoad()
    try {
      const nextPage = await fetchAudiobookshelfBookStates(bucket, page, PAGE_SIZE)
      if (isCurrentLoad(requestId)) {
        pages[bucket] = nextPage
      }
    } catch (err) {
      if (isCurrentLoad(requestId)) {
        error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
      }
    } finally {
      if (isCurrentLoad(requestId)) {
        loading.value = false
      }
    }
  }

  async function loadAllBuckets(): Promise<void> {
    const requestId = beginLoad()
    try {
      const [linked, needsReview, unmatched] = await Promise.all([
        fetchAudiobookshelfBookStates('linked', 0, PAGE_SIZE),
        fetchAudiobookshelfBookStates('needs-review', 0, PAGE_SIZE),
        fetchAudiobookshelfBookStates('unmatched', 0, PAGE_SIZE),
      ])
      if (isCurrentLoad(requestId)) {
        pages.linked = linked
        pages['needs-review'] = needsReview
        pages.unmatched = unmatched
      }
    } catch (err) {
      if (isCurrentLoad(requestId)) {
        error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
      }
    } finally {
      if (isCurrentLoad(requestId)) {
        loading.value = false
      }
    }
  }

  async function runAction(absLibraryItemId: string, action: () => Promise<unknown>): Promise<boolean> {
    actionId.value = absLibraryItemId
    error.value = null
    try {
      await action()
      await loadAllBuckets()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to update Audiobookshelf book'
      return false
    } finally {
      actionId.value = null
    }
  }

  async function confirmMatch(absLibraryItemId: string): Promise<boolean> {
    return runAction(absLibraryItemId, () => confirmAudiobookshelfMatch(absLibraryItemId))
  }

  async function linkBook(absLibraryItemId: string, bookId: number): Promise<boolean> {
    return runAction(absLibraryItemId, () => linkAudiobookshelfBook(absLibraryItemId, bookId))
  }

  async function unlinkBook(absLibraryItemId: string): Promise<boolean> {
    return runAction(absLibraryItemId, () => unlinkAudiobookshelfBook(absLibraryItemId))
  }

  async function setExcluded(absLibraryItemId: string, syncExcluded: boolean): Promise<boolean> {
    return runAction(absLibraryItemId, () => updateAudiobookshelfBookExclusion(absLibraryItemId, syncExcluded))
  }

  async function rescan(): Promise<boolean> {
    rescanning.value = true
    error.value = null
    try {
      await rescanAudiobookshelfMatches()
      await loadAllBuckets()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to rescan Audiobookshelf matches'
      return false
    } finally {
      rescanning.value = false
    }
  }

  return {
    pages,
    loading,
    rescanning,
    error,
    actionId,
    loadBucket,
    loadAllBuckets,
    confirmMatch,
    linkBook,
    unlinkBook,
    setExcluded,
    rescan,
  }
}
