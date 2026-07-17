import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfRescanResult } from '@bookorbit/types'
import type { AudiobookshelfBookState, AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage } from '../../api/audiobookshelf.api'
import { confirmAudiobookshelfMatch, fetchAudiobookshelfBookStates, rescanAudiobookshelfMatches } from '../../api/audiobookshelf.api'

vi.mock('../../api/audiobookshelf.api', () => ({
  fetchAudiobookshelfBookStates:
    vi.fn<(bucket: AudiobookshelfBookStateBucket, page: number, pageSize: number) => Promise<AudiobookshelfBookStatePage>>(),
  confirmAudiobookshelfMatch: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  linkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  rescanAudiobookshelfMatches: vi.fn<() => Promise<AudiobookshelfRescanResult>>(),
  unlinkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  updateAudiobookshelfBookExclusion: vi.fn<() => Promise<AudiobookshelfBookState>>(),
}))

const mockFetchBookStates = vi.mocked(fetchAudiobookshelfBookStates)
const mockConfirmMatch = vi.mocked(confirmAudiobookshelfMatch)
const mockRescanMatches = vi.mocked(rescanAudiobookshelfMatches)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function state(bucket: AudiobookshelfBookStateBucket, label: string): AudiobookshelfBookState {
  return {
    absLibraryItemId: `${bucket}-${label}`,
    absTitle: `${label} title`,
    absAuthorName: `${label} author`,
    absCoverUrl: null,
    bookId: bucket === 'unmatched' ? null : 7,
    bookTitle: bucket === 'unmatched' ? null : `${label} book`,
    bookAuthorName: bucket === 'unmatched' ? null : `${label} book author`,
    matchMethod: bucket === 'unmatched' ? null : 'isbn',
    matchConfidence: bucket === 'unmatched' ? null : 1,
    needsReview: bucket === 'needs-review',
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: null,
  }
}

function page(bucket: AudiobookshelfBookStateBucket, label: string, pageNumber = 0): AudiobookshelfBookStatePage {
  return {
    items: [state(bucket, label)],
    total: label === 'old' ? 1 : 2,
    page: pageNumber,
    pageSize: 20,
  }
}

async function loadComposable() {
  vi.resetModules()
  const { useAudiobookshelfLinkedBooks } = await import('../useAudiobookshelfLinkedBooks')
  return useAudiobookshelfLinkedBooks()
}

describe('useAudiobookshelfLinkedBooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfirmMatch.mockResolvedValue(state('linked', 'confirmed'))
    mockRescanMatches.mockResolvedValue({ queued: 0 })
  })

  it('keeps newer all-bucket results when an older all-bucket load resolves later', async () => {
    const olderLinked = deferred<AudiobookshelfBookStatePage>()
    const olderNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const olderUnmatched = deferred<AudiobookshelfBookStatePage>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(olderLinked.promise)
      .mockReturnValueOnce(olderNeedsReview.promise)
      .mockReturnValueOnce(olderUnmatched.promise)
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const olderLoad = linkedBooks.loadAllBuckets()
    const newerLoad = linkedBooks.loadAllBuckets()

    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
    expect(linkedBooks.pages['needs-review'].items[0]?.absLibraryItemId).toBe('needs-review-new')
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-new')
    expect(linkedBooks.loading.value).toBe(false)

    olderLinked.resolve(page('linked', 'old'))
    olderNeedsReview.resolve(page('needs-review', 'old'))
    olderUnmatched.resolve(page('unmatched', 'old'))
    await olderLoad

    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
    expect(linkedBooks.pages['needs-review'].items[0]?.absLibraryItemId).toBe('needs-review-new')
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-new')
    expect(mockFetchBookStates).toHaveBeenNthCalledWith(1, 'linked', 0, 20)
    expect(mockFetchBookStates).toHaveBeenNthCalledWith(2, 'needs-review', 0, 20)
    expect(mockFetchBookStates).toHaveBeenNthCalledWith(3, 'unmatched', 0, 20)
  })

  it('keeps a newer all-bucket refresh when an older paginated bucket load resolves later', async () => {
    const olderLinked = deferred<AudiobookshelfBookStatePage>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(olderLinked.promise)
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const olderLoad = linkedBooks.loadBucket('linked', 2)
    const newerLoad = linkedBooks.loadAllBuckets()

    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad
    olderLinked.resolve(page('linked', 'old', 2))
    await olderLoad

    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
    expect(linkedBooks.pages.linked.page).toBe(0)
    expect(mockFetchBookStates).toHaveBeenNthCalledWith(1, 'linked', 2, 20)
  })

  it('keeps unrelated full-refresh results when a newer paginated bucket load resolves first', async () => {
    const refreshLinked = deferred<AudiobookshelfBookStatePage>()
    const refreshNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const refreshUnmatched = deferred<AudiobookshelfBookStatePage>()
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(refreshLinked.promise)
      .mockReturnValueOnce(refreshNeedsReview.promise)
      .mockReturnValueOnce(refreshUnmatched.promise)
      .mockReturnValueOnce(linkedPage.promise)
    const linkedBooks = await loadComposable()

    const refresh = linkedBooks.loadAllBuckets()
    const pagination = linkedBooks.loadBucket('linked', 2)
    linkedPage.resolve(page('linked', 'page-two', 2))
    await pagination
    refreshLinked.resolve(page('linked', 'refresh'))
    refreshNeedsReview.resolve(page('needs-review', 'refresh'))
    refreshUnmatched.resolve(page('unmatched', 'refresh'))
    await refresh

    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-page-two')
    expect(linkedBooks.pages.linked.page).toBe(2)
    expect(linkedBooks.pages['needs-review'].items[0]?.absLibraryItemId).toBe('needs-review-refresh')
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-refresh')
  })

  it('allows concurrent different-bucket loads to commit independently', async () => {
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates.mockReturnValueOnce(linkedPage.promise).mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const linkedLoad = linkedBooks.loadBucket('linked', 1)
    const unmatchedLoad = linkedBooks.loadBucket('unmatched', 3)
    unmatchedPage.resolve(page('unmatched', 'page-three', 3))
    await unmatchedLoad

    expect(linkedBooks.loading.value).toBe(true)
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-page-three')

    linkedPage.resolve(page('linked', 'page-one', 1))
    await linkedLoad

    expect(linkedBooks.loading.value).toBe(false)
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-page-one')
    expect(linkedBooks.pages.linked.page).toBe(1)
  })

  it('tracks bucket loading independently while different buckets overlap', async () => {
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates.mockReturnValueOnce(linkedPage.promise).mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const linkedLoad = linkedBooks.loadBucket('linked', 1)
    const unmatchedLoad = linkedBooks.loadBucket('unmatched', 2)

    expect(linkedBooks.loading.value).toBe(true)
    expect(linkedBooks.bucketLoading.linked).toBe(true)
    expect(linkedBooks.bucketLoading['needs-review']).toBe(false)
    expect(linkedBooks.bucketLoading.unmatched).toBe(true)

    unmatchedPage.resolve(page('unmatched', 'page-two', 2))
    await unmatchedLoad

    expect(linkedBooks.loading.value).toBe(true)
    expect(linkedBooks.bucketLoading.linked).toBe(true)
    expect(linkedBooks.bucketLoading.unmatched).toBe(false)

    linkedPage.resolve(page('linked', 'page-one', 1))
    await linkedLoad

    expect(linkedBooks.loading.value).toBe(false)
    expect(linkedBooks.bucketLoading.linked).toBe(false)
  })

  it('commits trailing full-refresh bucket results after one bucket fails', async () => {
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    const needsReviewPage = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(linkedPage.promise)
      .mockReturnValueOnce(needsReviewPage.promise)
      .mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const refresh = linkedBooks.loadAllBuckets()
    linkedPage.reject(new Error('linked failed'))
    needsReviewPage.resolve(page('needs-review', 'refresh'))
    unmatchedPage.resolve(page('unmatched', 'refresh'))
    await refresh

    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.bucketErrors.linked).toBe('linked failed')
    expect(linkedBooks.bucketErrors['needs-review']).toBeNull()
    expect(linkedBooks.bucketErrors.unmatched).toBeNull()
    expect(linkedBooks.loading.value).toBe(false)
    expect(linkedBooks.pages['needs-review'].items[0]?.absLibraryItemId).toBe('needs-review-refresh')
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-refresh')
  })

  it('keeps a bucket failure when a newer unrelated bucket succeeds first', async () => {
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates.mockReturnValueOnce(linkedPage.promise).mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const linkedLoad = linkedBooks.loadBucket('linked', 1)
    const unmatchedLoad = linkedBooks.loadBucket('unmatched', 2)
    unmatchedPage.resolve(page('unmatched', 'page-two', 2))
    await unmatchedLoad
    linkedPage.reject(new Error('linked failed'))
    await linkedLoad

    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-page-two')
    expect(linkedBooks.bucketErrors.linked).toBe('linked failed')
    expect(linkedBooks.bucketErrors.unmatched).toBeNull()
    expect(linkedBooks.error.value).toBeNull()
  })

  it('keeps a bucket failure when an unrelated bucket succeeds later', async () => {
    const linkedPage = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates.mockReturnValueOnce(linkedPage.promise).mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const linkedLoad = linkedBooks.loadBucket('linked', 1)
    linkedPage.reject(new Error('linked failed'))
    await linkedLoad
    const unmatchedLoad = linkedBooks.loadBucket('unmatched', 2)
    unmatchedPage.resolve(page('unmatched', 'page-two', 2))
    await unmatchedLoad

    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-page-two')
    expect(linkedBooks.bucketErrors.linked).toBe('linked failed')
    expect(linkedBooks.bucketErrors.unmatched).toBeNull()
    expect(linkedBooks.error.value).toBeNull()
  })

  it('clears same-bucket loading and error after retry success', async () => {
    const failedLinkedPage = deferred<AudiobookshelfBookStatePage>()
    const retryLinkedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates.mockReturnValueOnce(failedLinkedPage.promise).mockReturnValueOnce(retryLinkedPage.promise)
    const linkedBooks = await loadComposable()

    const failedLoad = linkedBooks.loadBucket('linked', 1)
    failedLinkedPage.reject(new Error('linked failed'))
    await failedLoad

    expect(linkedBooks.bucketErrors.linked).toBe('linked failed')
    expect(linkedBooks.bucketLoading.linked).toBe(false)

    const retryLoad = linkedBooks.loadBucket('linked', 1)
    expect(linkedBooks.bucketErrors.linked).toBeNull()
    expect(linkedBooks.bucketLoading.linked).toBe(true)

    retryLinkedPage.resolve(page('linked', 'retry', 1))
    await retryLoad

    expect(linkedBooks.bucketLoading.linked).toBe(false)
    expect(linkedBooks.bucketErrors.linked).toBeNull()
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-retry')
  })

  it('keeps a full-refresh bucket failure after unrelated pagination succeeds', async () => {
    const refreshLinked = deferred<AudiobookshelfBookStatePage>()
    const refreshNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const refreshUnmatched = deferred<AudiobookshelfBookStatePage>()
    const unmatchedPage = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(refreshLinked.promise)
      .mockReturnValueOnce(refreshNeedsReview.promise)
      .mockReturnValueOnce(refreshUnmatched.promise)
      .mockReturnValueOnce(unmatchedPage.promise)
    const linkedBooks = await loadComposable()

    const refresh = linkedBooks.loadAllBuckets()
    refreshLinked.reject(new Error('linked refresh failed'))
    refreshNeedsReview.resolve(page('needs-review', 'refresh'))
    refreshUnmatched.resolve(page('unmatched', 'refresh'))
    await refresh
    const pagination = linkedBooks.loadBucket('unmatched', 4)
    unmatchedPage.resolve(page('unmatched', 'page-four', 4))
    await pagination

    expect(linkedBooks.bucketErrors.linked).toBe('linked refresh failed')
    expect(linkedBooks.bucketErrors.unmatched).toBeNull()
    expect(linkedBooks.pages.unmatched.items[0]?.absLibraryItemId).toBe('unmatched-page-four')
    expect(linkedBooks.pages.unmatched.page).toBe(4)
  })

  it('does not let a superseded request clear loading while the current request is pending', async () => {
    const olderLinked = deferred<AudiobookshelfBookStatePage>()
    const olderNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const olderUnmatched = deferred<AudiobookshelfBookStatePage>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(olderLinked.promise)
      .mockReturnValueOnce(olderNeedsReview.promise)
      .mockReturnValueOnce(olderUnmatched.promise)
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const olderLoad = linkedBooks.loadAllBuckets()
    const newerLoad = linkedBooks.loadAllBuckets()
    olderLinked.resolve(page('linked', 'old'))
    olderNeedsReview.resolve(page('needs-review', 'old'))
    olderUnmatched.resolve(page('unmatched', 'old'))
    await olderLoad

    expect(linkedBooks.loading.value).toBe(true)

    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad

    expect(linkedBooks.loading.value).toBe(false)
  })

  it('does not surface stale errors from superseded requests', async () => {
    const olderLinked = deferred<AudiobookshelfBookStatePage>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockFetchBookStates
      .mockReturnValueOnce(olderLinked.promise)
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const olderLoad = linkedBooks.loadBucket('linked', 1)
    const newerLoad = linkedBooks.loadAllBuckets()
    olderLinked.reject(new Error('old load failed'))
    await olderLoad

    expect(linkedBooks.loading.value).toBe(true)
    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.bucketErrors.linked).toBeNull()

    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad

    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.bucketErrors.linked).toBeNull()
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
  })

  it('does not surface a stale rescan rejection after a newer refresh succeeds', async () => {
    const rescan = deferred<AudiobookshelfRescanResult>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockRescanMatches.mockReturnValueOnce(rescan.promise)
    mockFetchBookStates
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const rescanResult = linkedBooks.rescan()
    const newerLoad = linkedBooks.loadAllBuckets()
    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad
    rescan.reject(new Error('rescan failed'))

    await expect(rescanResult).resolves.toBe(false)
    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.rescanning.value).toBe(false)
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
  })

  it('does not surface a stale action rejection after a newer refresh succeeds', async () => {
    const action = deferred<AudiobookshelfBookState>()
    const newerLinked = deferred<AudiobookshelfBookStatePage>()
    const newerNeedsReview = deferred<AudiobookshelfBookStatePage>()
    const newerUnmatched = deferred<AudiobookshelfBookStatePage>()
    mockConfirmMatch.mockReturnValueOnce(action.promise)
    mockFetchBookStates
      .mockReturnValueOnce(newerLinked.promise)
      .mockReturnValueOnce(newerNeedsReview.promise)
      .mockReturnValueOnce(newerUnmatched.promise)
    const linkedBooks = await loadComposable()

    const actionResult = linkedBooks.confirmMatch('abs-1')
    const newerLoad = linkedBooks.loadAllBuckets()
    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad
    action.reject(new Error('action failed'))

    await expect(actionResult).resolves.toBe(false)
    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.actionId.value).toBeNull()
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
  })
})
