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
const BUCKETS = ['linked', 'needs-review', 'unmatched'] as const

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
const bucketLoading = reactive<Record<AudiobookshelfBookStateBucket, boolean>>({
  linked: false,
  'needs-review': false,
  unmatched: false,
})
const bucketErrors = reactive<Record<AudiobookshelfBookStateBucket, string | null>>({
  linked: null,
  'needs-review': null,
  unmatched: null,
})

const bucketRequestIds: Record<AudiobookshelfBookStateBucket, number> = {
  linked: 0,
  'needs-review': 0,
  unmatched: 0,
}
let nextBucketRequestId = 0

async function loadBucketPage(bucket: AudiobookshelfBookStateBucket, page: number): Promise<void> {
  const requestId = ++nextBucketRequestId
  bucketRequestIds[bucket] = requestId
  bucketErrors[bucket] = null
  bucketLoading[bucket] = true
  loading.value = true
  try {
    const nextPage = await fetchAudiobookshelfBookStates(bucket, page, PAGE_SIZE)
    if (bucketRequestIds[bucket] === requestId) pages[bucket] = nextPage
  } catch (err) {
    if (bucketRequestIds[bucket] === requestId) {
      bucketErrors[bucket] = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
    }
  } finally {
    if (bucketRequestIds[bucket] === requestId) bucketLoading[bucket] = false
    loading.value = BUCKETS.some((candidate) => bucketLoading[candidate])
  }
}

export function useAudiobookshelfLinkedBooks() {
  async function loadBucket(bucket: AudiobookshelfBookStateBucket, page = pages[bucket].page): Promise<void> {
    error.value = null
    await loadBucketPage(bucket, page)
  }

  async function loadAllBuckets(): Promise<void> {
    error.value = null
    await Promise.all(BUCKETS.map((bucket) => loadBucketPage(bucket, 0)))
  }

  async function runAction(absLibraryItemId: string, action: () => Promise<unknown>): Promise<boolean> {
    error.value = null
    actionId.value = absLibraryItemId
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

  async function rescan(): Promise<boolean> {
    error.value = null
    rescanning.value = true
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

  return {
    pages,
    loading,
    bucketLoading,
    rescanning,
    error,
    bucketErrors,
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
