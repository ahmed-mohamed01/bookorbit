import { reactive, ref } from 'vue'
import {
  cleanupAudiobookshelfStaleEntries,
  confirmAudiobookshelfMatch,
  fetchAudiobookshelfBookStates,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
  type AudiobookshelfBookState,
  type AudiobookshelfBookStatePage,
  type AudiobookshelfBookStateBucket,
  type AudiobookshelfCleanupPayload,
  type AudiobookshelfCleanupResult,
} from '../api/audiobookshelf.api'
import { useAudiobookshelfSettings } from './useAudiobookshelfSettings'

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
const cleaningUp = ref(false)
const error = ref<string | null>(null)
// Cleanup is driven from the sync-progress card, not the linked-books list, so it keeps its own
// error instead of clearing or hijacking the banner that list renders from `error`.
const cleanupError = ref<string | null>(null)
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
// Free-text filter shared by all three bucket queries. Kept module-level (alongside `pages`) so a
// pagination click still carries whatever search is active, without every call site re-passing it.
const searchQuery = ref('')

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
    let nextPage = await fetchAudiobookshelfBookStates(bucket, page, PAGE_SIZE, searchQuery.value || undefined)
    // Self-healing clamp: a page beyond the end (rows removed, or a stale total raced a new filter)
    // comes back empty; refetch the real last page instead of stranding the pager past it.
    if (nextPage.items.length === 0 && nextPage.page > 0 && nextPage.total > 0) {
      const lastPage = Math.max(0, Math.ceil(nextPage.total / PAGE_SIZE) - 1)
      nextPage = await fetchAudiobookshelfBookStates(bucket, lastPage, PAGE_SIZE, searchQuery.value || undefined)
    }
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

// Which bucket an item belongs in, mirroring the server's bucketClause (audiobookshelf.repository.ts):
// linked = has a book, confirmed, no match error; needs-review = flagged for review regardless of
// bookId; unmatched = no book at all. Used to move an item between buckets locally after an action
// instead of reloading all three from the server.
function bucketForItem(item: AudiobookshelfBookState): AudiobookshelfBookStateBucket | null {
  if (item.needsReview) return 'needs-review'
  if (item.bookId == null) return 'unmatched'
  if (item.matchError == null) return 'linked'
  return null
}

function findCurrentBucket(absLibraryItemId: string): AudiobookshelfBookStateBucket | null {
  for (const bucket of BUCKETS) {
    if (pages[bucket].items.some((item) => item.absLibraryItemId === absLibraryItemId)) return bucket
  }
  return null
}

function removeItemFromBucket(bucket: AudiobookshelfBookStateBucket, absLibraryItemId: string): void {
  const target = pages[bucket]
  const index = target.items.findIndex((item) => item.absLibraryItemId === absLibraryItemId)
  if (index === -1) return
  target.items.splice(index, 1)
  target.total = Math.max(0, target.total - 1)
}

function addItemToBucket(bucket: AudiobookshelfBookStateBucket, item: AudiobookshelfBookState): void {
  const target = pages[bucket]
  // Only splice into the currently-loaded page when it's page 0: a moved item sorts first (most
  // recently updated) on a full reload, so this keeps the visible page consistent with that ordering
  // without guessing where it would land on a later page. The total still moves either way, so
  // pagination (page count, "showing X of Y") stays correct even when the item isn't shown.
  if (target.page === 0) {
    target.items = [item, ...target.items].slice(0, target.pageSize)
  }
  target.total += 1
}

function replaceItemInBucket(bucket: AudiobookshelfBookStateBucket, item: AudiobookshelfBookState): void {
  const target = pages[bucket]
  const index = target.items.findIndex((existing) => existing.absLibraryItemId === item.absLibraryItemId)
  if (index !== -1) target.items.splice(index, 1, item)
}

// Applies a mutation response locally instead of reloading all three buckets: moves the item between
// bucket arrays when its bucket changed (confirm, link, unlink), or updates it in place when it didn't
// (exclusion toggle). Falls back to nothing extra on failure - runAction only calls this on success.
function applyLocalUpdate(
  item: AudiobookshelfBookState,
  fromBucket: AudiobookshelfBookStateBucket | null,
  toBucket: AudiobookshelfBookStateBucket | null,
): void {
  if (fromBucket === toBucket) {
    if (toBucket) replaceItemInBucket(toBucket, item)
    return
  }
  if (fromBucket) removeItemFromBucket(fromBucket, item.absLibraryItemId)
  if (toBucket) addItemToBucket(toBucket, item)
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

  // Resets every bucket to page 0 under the new filter - the search box applies across all three tabs
  // (and their counts), not just the active one.
  async function setSearchQuery(query: string): Promise<void> {
    searchQuery.value = query
    await loadAllBuckets()
  }

  async function runAction(absLibraryItemId: string, action: () => Promise<AudiobookshelfBookState>): Promise<boolean> {
    error.value = null
    actionId.value = absLibraryItemId
    try {
      const updated = await action()
      // The local move is only provably consistent on unfiltered page 0: an active filter needs the
      // server to re-decide membership, and a non-first page cannot absorb a removal or insertion
      // without shifting rows it does not hold. Reload just the affected buckets in those cases.
      const fromBucket = findCurrentBucket(updated.absLibraryItemId)
      const toBucket = bucketForItem(updated)
      const affected = [...new Set([fromBucket, toBucket])].filter((bucket): bucket is AudiobookshelfBookStateBucket => bucket != null)
      const localSafe = !searchQuery.value && affected.every((bucket) => pages[bucket].page === 0)
      if (localSafe) {
        applyLocalUpdate(updated, fromBucket, toBucket)
      } else {
        await Promise.all(affected.map((bucket) => loadBucket(bucket)))
      }
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
      // A rescan can re-match many items across all three buckets asynchronously - its response is just
      // a queued count, not enough to update locally, so this still falls back to a full reload. The
      // settings come along because they carry the recalculated staleCount the cleanup indicator reads.
      await rescanAudiobookshelfMatches()
      await useAudiobookshelfSettings().fetchSettings()
      await loadAllBuckets()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to rescan Audiobookshelf matches'
      return false
    } finally {
      rescanning.value = false
    }
  }

  // Returns the server's counts on success (the caller reports them) and null on failure, where
  // `cleanupError` carries the reason. A successful run can drop rows from any bucket, so all three reload.
  async function cleanupStale(payload: AudiobookshelfCleanupPayload = {}): Promise<AudiobookshelfCleanupResult | null> {
    cleanupError.value = null
    cleaningUp.value = true
    try {
      const result = await cleanupAudiobookshelfStaleEntries(payload)
      await loadAllBuckets()
      return result
    } catch (err) {
      cleanupError.value = err instanceof Error ? err.message : 'Failed to clean up stale Audiobookshelf entries'
      return null
    } finally {
      cleaningUp.value = false
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
    searchQuery,
    loading,
    bucketLoading,
    rescanning,
    cleaningUp,
    error,
    cleanupError,
    bucketErrors,
    actionId,
    loadBucket,
    loadAllBuckets,
    setSearchQuery,
    confirmMatch,
    linkBook,
    unlinkBook,
    setExcluded,
    rescan,
    cleanupStale,
  }
}
