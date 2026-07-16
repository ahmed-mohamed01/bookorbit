import { reactive, ref } from 'vue'
import {
  confirmAudiobookshelfMatch,
  fetchAudiobookshelfBookStates,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
  type AudiobookshelfBookStatePage,
  type AudiobookshelfMatchBucket,
} from '../api/audiobookshelf.api'

const PAGE_SIZE = 20

function emptyPage(): AudiobookshelfBookStatePage {
  return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE }
}

const pages = reactive<Record<AudiobookshelfMatchBucket, AudiobookshelfBookStatePage>>({
  linked: emptyPage(),
  'needs-review': emptyPage(),
  unmatched: emptyPage(),
})
const loading = ref(false)
const rescanning = ref(false)
const error = ref<string | null>(null)
const actionId = ref<string | null>(null)

export function useAudiobookshelfLinkedBooks() {
  async function loadBucket(bucket: AudiobookshelfMatchBucket, page = pages[bucket].page): Promise<void> {
    loading.value = true
    error.value = null
    try {
      pages[bucket] = await fetchAudiobookshelfBookStates(bucket, page, PAGE_SIZE)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
    } finally {
      loading.value = false
    }
  }

  async function loadAllBuckets(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [linked, needsReview, unmatched] = await Promise.all([
        fetchAudiobookshelfBookStates('linked', 1, PAGE_SIZE),
        fetchAudiobookshelfBookStates('needs-review', 1, PAGE_SIZE),
        fetchAudiobookshelfBookStates('unmatched', 1, PAGE_SIZE),
      ])
      pages.linked = linked
      pages['needs-review'] = needsReview
      pages.unmatched = unmatched
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
    } finally {
      loading.value = false
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
