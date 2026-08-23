import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookState, AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage } from '@bookorbit/types'

vi.mock('../../api/audiobookshelf.api', () => ({
  fetchAudiobookshelfBookStates:
    vi.fn<(bucket: AudiobookshelfBookStateBucket, page: number, pageSize: number, q?: string) => Promise<AudiobookshelfBookStatePage>>(),
  confirmAudiobookshelfMatch: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  linkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  unlinkAudiobookshelfBook: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  updateAudiobookshelfBookExclusion: vi.fn<() => Promise<AudiobookshelfBookState>>(),
  rescanAudiobookshelfMatches: vi.fn<() => Promise<{ queued: number }>>(),
}))

import {
  confirmAudiobookshelfMatch,
  fetchAudiobookshelfBookStates,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
} from '../../api/audiobookshelf.api'

const mockFetchBookStates = vi.mocked(fetchAudiobookshelfBookStates)
const mockConfirm = vi.mocked(confirmAudiobookshelfMatch)
const mockLink = vi.mocked(linkAudiobookshelfBook)
const mockUnlink = vi.mocked(unlinkAudiobookshelfBook)
const mockSetExcluded = vi.mocked(updateAudiobookshelfBookExclusion)
const mockRescan = vi.mocked(rescanAudiobookshelfMatches)

function page(total = 0): AudiobookshelfBookStatePage {
  return { items: [], total, page: 0, pageSize: 20 }
}

function item(overrides: Partial<AudiobookshelfBookState> = {}): AudiobookshelfBookState {
  return {
    absLibraryItemId: 'li-1',
    absTitle: 'ABS Title',
    absAuthorName: 'ABS Author',
    bookId: null,
    bookTitle: null,
    bookAuthorName: null,
    matchMethod: null,
    matchConfidence: null,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: null,
    ...overrides,
  }
}

async function loadComposable() {
  const { useAudiobookshelfLinkedBooks } = await import('../useAudiobookshelfLinkedBooks')
  return useAudiobookshelfLinkedBooks()
}

describe('useAudiobookshelfLinkedBooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockFetchBookStates.mockResolvedValue(page())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loadAllBuckets loads the three buckets in parallel', async () => {
    mockFetchBookStates.mockImplementation((bucket) => Promise.resolve(page(bucket === 'linked' ? 5 : 0)))
    const c = await loadComposable()

    await c.loadAllBuckets()

    const buckets = mockFetchBookStates.mock.calls.map((call) => call[0]).sort()
    expect(buckets).toEqual(['linked', 'needs-review', 'unmatched'])
    expect(mockFetchBookStates).toHaveBeenCalledTimes(3)
    expect(c.pages.linked.total).toBe(5)
    expect(c.loading.value).toBe(false)
  })

  it('records a per-bucket error without wiping the other buckets', async () => {
    mockFetchBookStates.mockImplementation((bucket) => {
      if (bucket === 'unmatched') return Promise.reject(new Error('boom'))
      return Promise.resolve(page())
    })
    const c = await loadComposable()

    await c.loadAllBuckets()

    expect(c.bucketErrors.unmatched).toBe('boom')
    expect(c.bucketErrors.linked).toBeNull()
  })

  it('runAction returns false and sets error when the action rejects', async () => {
    mockLink.mockRejectedValue(new Error('Cannot link'))
    const c = await loadComposable()

    const ok = await c.linkBook('li-1', 42)

    expect(ok).toBe(false)
    expect(c.error.value).toBe('Cannot link')
    expect(mockFetchBookStates).not.toHaveBeenCalled()
  })

  it('confirm moves the item from needs-review into linked and adjusts both bucket totals, without a full reload', async () => {
    const needsReviewItem = item({ absLibraryItemId: 'li-1', needsReview: true, bookId: 42 })
    mockFetchBookStates.mockImplementation((bucket) =>
      Promise.resolve(bucket === 'needs-review' ? { items: [needsReviewItem], total: 1, page: 0, pageSize: 20 } : page()),
    )
    const c = await loadComposable()
    await c.loadAllBuckets()
    mockFetchBookStates.mockClear()

    const confirmed = item({ absLibraryItemId: 'li-1', needsReview: false, bookId: 42, bookTitle: 'Confirmed Book' })
    mockConfirm.mockResolvedValue(confirmed)

    const ok = await c.confirmMatch('li-1')

    expect(ok).toBe(true)
    expect(mockFetchBookStates).not.toHaveBeenCalled()
    expect(c.pages['needs-review'].items).toEqual([])
    expect(c.pages['needs-review'].total).toBe(0)
    expect(c.pages.linked.items).toEqual([confirmed])
    expect(c.pages.linked.total).toBe(1)
    expect(c.actionId.value).toBeNull()
  })

  it('link moves the item from unmatched into linked and adjusts both bucket totals', async () => {
    const unmatchedItem = item({ absLibraryItemId: 'li-1' })
    mockFetchBookStates.mockImplementation((bucket) =>
      Promise.resolve(bucket === 'unmatched' ? { items: [unmatchedItem], total: 1, page: 0, pageSize: 20 } : page()),
    )
    const c = await loadComposable()
    await c.loadAllBuckets()
    mockFetchBookStates.mockClear()

    const linked = item({ absLibraryItemId: 'li-1', bookId: 42, bookTitle: 'Linked Book', matchMethod: 'manual' })
    mockLink.mockResolvedValue(linked)

    const ok = await c.linkBook('li-1', 42)

    expect(ok).toBe(true)
    expect(mockFetchBookStates).not.toHaveBeenCalled()
    expect(c.pages.unmatched.items).toEqual([])
    expect(c.pages.unmatched.total).toBe(0)
    expect(c.pages.linked.items).toEqual([linked])
    expect(c.pages.linked.total).toBe(1)
  })

  it('unlink moves the item from linked into unmatched and adjusts both bucket totals', async () => {
    const linkedItem = item({ absLibraryItemId: 'li-1', bookId: 42, bookTitle: 'Linked Book' })
    mockFetchBookStates.mockImplementation((bucket) =>
      Promise.resolve(bucket === 'linked' ? { items: [linkedItem], total: 1, page: 0, pageSize: 20 } : page()),
    )
    const c = await loadComposable()
    await c.loadAllBuckets()
    mockFetchBookStates.mockClear()

    const unlinked = item({ absLibraryItemId: 'li-1', bookId: null })
    mockUnlink.mockResolvedValue(unlinked)

    const ok = await c.unlinkBook('li-1')

    expect(ok).toBe(true)
    expect(mockFetchBookStates).not.toHaveBeenCalled()
    expect(c.pages.linked.items).toEqual([])
    expect(c.pages.linked.total).toBe(0)
    expect(c.pages.unmatched.items).toEqual([unlinked])
    expect(c.pages.unmatched.total).toBe(1)
  })

  it('toggling exclusion updates the item in place without moving buckets or reloading', async () => {
    const linkedItem = item({ absLibraryItemId: 'li-1', bookId: 42, syncExcluded: false })
    mockFetchBookStates.mockImplementation((bucket) =>
      Promise.resolve(bucket === 'linked' ? { items: [linkedItem], total: 1, page: 0, pageSize: 20 } : page()),
    )
    const c = await loadComposable()
    await c.loadAllBuckets()
    mockFetchBookStates.mockClear()

    const excluded = item({ absLibraryItemId: 'li-1', bookId: 42, syncExcluded: true })
    mockSetExcluded.mockResolvedValue(excluded)

    const ok = await c.setExcluded('li-1', true)

    expect(ok).toBe(true)
    expect(mockFetchBookStates).not.toHaveBeenCalled()
    expect(c.pages.linked.items).toEqual([excluded])
    expect(c.pages.linked.total).toBe(1)
  })

  it('setSearchQuery resets every bucket to page 0 and threads the query through', async () => {
    const c = await loadComposable()
    await c.loadAllBuckets()
    mockFetchBookStates.mockClear()

    await c.setSearchQuery('dune')

    expect(mockFetchBookStates).toHaveBeenCalledTimes(3)
    for (const call of mockFetchBookStates.mock.calls) {
      expect(call[1]).toBe(0)
      expect(call[3]).toBe('dune')
    }
  })

  it('carries the active search query into a later pagination request', async () => {
    const c = await loadComposable()
    await c.setSearchQuery('dune')
    mockFetchBookStates.mockClear()

    await c.loadBucket('linked', 1)

    expect(mockFetchBookStates).toHaveBeenCalledWith('linked', 1, 20, 'dune')
  })

  it('rescan toggles the rescanning flag and reloads buckets', async () => {
    mockRescan.mockResolvedValue({ queued: 2 })
    const c = await loadComposable()

    const ok = await c.rescan()

    expect(ok).toBe(true)
    expect(c.rescanning.value).toBe(false)
    expect(mockFetchBookStates).toHaveBeenCalledTimes(3)
  })

  it('drops a stale bucket response when a newer request for the same bucket resolves first', async () => {
    const resolvers: Array<(value: AudiobookshelfBookStatePage) => void> = []
    mockFetchBookStates.mockImplementation(() => new Promise<AudiobookshelfBookStatePage>((resolve) => resolvers.push(resolve)))
    const c = await loadComposable()

    const first = c.loadBucket('linked')
    const second = c.loadBucket('linked')

    resolvers[1]!({ items: [], total: 99, page: 0, pageSize: 20 })
    resolvers[0]!({ items: [], total: 1, page: 0, pageSize: 20 })
    await Promise.all([first, second])

    expect(c.pages.linked.total).toBe(99)
  })
})
