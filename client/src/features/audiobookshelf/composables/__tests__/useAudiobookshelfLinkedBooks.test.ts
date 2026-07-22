import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookState, AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage } from '@bookorbit/types'

vi.mock('../../api/audiobookshelf.api', () => ({
  fetchAudiobookshelfBookStates:
    vi.fn<(bucket: AudiobookshelfBookStateBucket, page: number, pageSize: number) => Promise<AudiobookshelfBookStatePage>>(),
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
} from '../../api/audiobookshelf.api'

const mockFetchBookStates = vi.mocked(fetchAudiobookshelfBookStates)
const mockConfirm = vi.mocked(confirmAudiobookshelfMatch)
const mockLink = vi.mocked(linkAudiobookshelfBook)
const mockRescan = vi.mocked(rescanAudiobookshelfMatches)

function page(total = 0): AudiobookshelfBookStatePage {
  return { items: [], total, page: 0, pageSize: 20 }
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

  it('runAction reloads all buckets after a successful confirm', async () => {
    mockConfirm.mockResolvedValue({ absLibraryItemId: 'li-1' } as AudiobookshelfBookState)
    const c = await loadComposable()

    const ok = await c.confirmMatch('li-1')

    expect(ok).toBe(true)
    expect(mockConfirm).toHaveBeenCalledWith('li-1')
    expect(mockFetchBookStates).toHaveBeenCalledTimes(3)
    expect(c.actionId.value).toBeNull()
  })

  it('runAction returns false and sets error when the action rejects', async () => {
    mockLink.mockRejectedValue(new Error('Cannot link'))
    const c = await loadComposable()

    const ok = await c.linkBook('li-1', 42)

    expect(ok).toBe(false)
    expect(c.error.value).toBe('Cannot link')
    expect(mockFetchBookStates).not.toHaveBeenCalled()
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
