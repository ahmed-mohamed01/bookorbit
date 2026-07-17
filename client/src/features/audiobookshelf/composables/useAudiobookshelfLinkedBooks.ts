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
const activeLoadRequestIds = new Set<number>()
let nextBucketRequestId = 0
let nextOperationId = 0
let errorOwnerId = 0
let actionOwnerId = 0
let rescanOwnerId = 0

function beginOperation(): number {
  const operationId = ++nextOperationId
  errorOwnerId = operationId
  error.value = null
  return operationId
}

function ownsError(operationId: number): boolean {
  return operationId === errorOwnerId
}

function beginBucketLoad(bucket: AudiobookshelfBookStateBucket): number {
  const requestId = ++nextBucketRequestId
  bucketRequestIds[bucket] = requestId
  bucketErrors[bucket] = null
  activeLoadRequestIds.add(requestId)
  updateLoading()
  return requestId
}

function finishBucketLoad(requestId: number): void {
  activeLoadRequestIds.delete(requestId)
  updateLoading()
}

function updateLoading(): void {
  loading.value = BUCKETS.some((bucket) => activeLoadRequestIds.has(bucketRequestIds[bucket]))
}

function ownsBucket(bucket: AudiobookshelfBookStateBucket, requestId: number): boolean {
  return bucketRequestIds[bucket] === requestId
}

function setLoadError(bucket: AudiobookshelfBookStateBucket, requestId: number, err: unknown): void {
  if (ownsBucket(bucket, requestId)) {
    bucketErrors[bucket] = err instanceof Error ? err.message : 'Failed to load Audiobookshelf books'
  }
}

export function useAudiobookshelfLinkedBooks() {
  async function loadBucket(bucket: AudiobookshelfBookStateBucket, page = pages[bucket].page): Promise<void> {
    beginOperation()
    const requestId = beginBucketLoad(bucket)
    try {
      const nextPage = await fetchAudiobookshelfBookStates(bucket, page, PAGE_SIZE)
      if (ownsBucket(bucket, requestId)) {
        pages[bucket] = nextPage
      }
    } catch (err) {
      setLoadError(bucket, requestId, err)
    } finally {
      finishBucketLoad(requestId)
    }
  }

  async function loadAllBuckets(): Promise<void> {
    beginOperation()
    await Promise.all(
      BUCKETS.map(async (bucket) => {
        const requestId = beginBucketLoad(bucket)
        try {
          const nextPage = await fetchAudiobookshelfBookStates(bucket, 0, PAGE_SIZE)
          if (ownsBucket(bucket, requestId)) {
            pages[bucket] = nextPage
          }
        } catch (err) {
          setLoadError(bucket, requestId, err)
        } finally {
          finishBucketLoad(requestId)
        }
      }),
    )
  }

  async function runAction(absLibraryItemId: string, action: () => Promise<unknown>): Promise<boolean> {
    const operationId = beginOperation()
    actionOwnerId = operationId
    actionId.value = absLibraryItemId
    try {
      await action()
      await loadAllBuckets()
      return true
    } catch (err) {
      if (ownsError(operationId)) {
        error.value = err instanceof Error ? err.message : 'Failed to update Audiobookshelf book'
      }
      return false
    } finally {
      if (actionOwnerId === operationId) {
        actionId.value = null
      }
    }
  }

  async function rescan(): Promise<boolean> {
    const operationId = beginOperation()
    rescanOwnerId = operationId
    rescanning.value = true
    try {
      await rescanAudiobookshelfMatches()
      await loadAllBuckets()
      return true
    } catch (err) {
      if (ownsError(operationId)) {
        error.value = err instanceof Error ? err.message : 'Failed to rescan Audiobookshelf matches'
      }
      return false
    } finally {
      if (rescanOwnerId === operationId) {
        rescanning.value = false
      }
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
