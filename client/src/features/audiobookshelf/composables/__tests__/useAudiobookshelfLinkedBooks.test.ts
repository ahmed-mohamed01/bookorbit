import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookState, AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage } from '../../api/audiobookshelf.api'
import { fetchAudiobookshelfBookStates } from '../../api/audiobookshelf.api'

vi.mock('../../api/audiobookshelf.api', () => ({
  fetchAudiobookshelfBookStates:
    vi.fn<(bucket: AudiobookshelfBookStateBucket, page: number, pageSize: number) => Promise<AudiobookshelfBookStatePage>>(),
  confirmAudiobookshelfMatch: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  linkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  rescanAudiobookshelfMatches: vi.fn<() => Promise<unknown>>(),
  unlinkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  updateAudiobookshelfBookExclusion: vi.fn<() => Promise<AudiobookshelfBookState>>(),
}))

const mockFetchBookStates = vi.mocked(fetchAudiobookshelfBookStates)

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

    newerLinked.resolve(page('linked', 'new'))
    newerNeedsReview.resolve(page('needs-review', 'new'))
    newerUnmatched.resolve(page('unmatched', 'new'))
    await newerLoad

    expect(linkedBooks.error.value).toBeNull()
    expect(linkedBooks.pages.linked.items[0]?.absLibraryItemId).toBe('linked-new')
  })
})
