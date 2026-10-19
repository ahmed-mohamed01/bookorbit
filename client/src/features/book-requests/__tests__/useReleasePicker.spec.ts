// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseCandidateItem, ReleaseFileInspection } from '@bookorbit/types'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }))
vi.mock('@/lib/api', () => ({ api: apiMock }))

import {
  TITLE_AUTHOR_SEARCH_KEY,
  clearReleaseSearchCache,
  peekReleaseSearch,
  prefetchReleaseSearch,
  useReleasePicker,
} from '../composables/useReleasePicker'

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

/** A finished release search stream: zero or more progress frames, then the final result. */
function sse(result: unknown, progress: unknown[] = []): Response {
  const frames = [
    ...progress.map((snapshot) => `event: progress\ndata: ${JSON.stringify(snapshot)}`),
    `event: result\ndata: ${JSON.stringify(result)}`,
  ]
  return { ok: true, status: 200, body: undefined, text: async () => `${frames.join('\n\n')}\n\n` } as unknown as Response
}

/**
 * A stream the test feeds frame by frame, so the mid-search state can be asserted before the
 * result arrives.
 */
function handFedStream() {
  const frames: string[] = []
  const waiters: Array<(read: { done: boolean; value?: Uint8Array }) => void> = []
  const encoder = new TextEncoder()
  let closed = false
  const deliver = (): void => {
    while (frames.length > 0 && waiters.length > 0) waiters.shift()!({ done: false, value: encoder.encode(frames.shift()!) })
    if (closed && frames.length === 0) for (const waiter of waiters.splice(0)) waiter({ done: true })
  }
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            if (frames.length > 0) resolve({ done: false, value: encoder.encode(frames.shift()!) })
            else if (closed) resolve({ done: true })
            else waiters.push(resolve)
          }),
      }),
    },
  } as unknown as Response
  const settle = (): void => {
    closed = true
    deliver()
  }
  return {
    response,
    sendProgress(snapshot: unknown): void {
      frames.push(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`)
      deliver()
    },
    sendResult(result: unknown): void {
      frames.push(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
      settle()
    },
    close: settle,
  }
}

const release = { indexerId: 9, guid: 'release-guid' } as ReleaseCandidateItem

function searchResult(
  overrides: {
    activeIsbn?: string | null
    releases?: ReleaseCandidateItem[]
    uncoveredIndexerCount?: number
    enabledIndexerCount?: number
    configuredIndexerCount?: number
  } = {},
) {
  return {
    releases: overrides.releases ?? [],
    criteria: {
      title: 'Dune',
      authors: ['Frank Herbert'],
      isbn10: null,
      isbn13: null,
      activeIsbn: overrides.activeIsbn ?? null,
      isbns: [],
      mediaKind: 'ebook',
      language: null,
      preferredFormats: ['epub'],
    },
    indexers: [],
    uncoveredIndexerCount: overrides.uncoveredIndexerCount ?? 0,
    enabledIndexerCount: overrides.enabledIndexerCount ?? 1,
    configuredIndexerCount: overrides.configuredIndexerCount ?? 1,
    profileActive: false,
    cached: false,
  }
}
const inspection: ReleaseFileInspection = {
  source: 'torrent_file',
  status: 'ready',
  files: [{ path: 'book.epub', sizeBytes: 1024, bookFile: true }],
  totalFiles: 1,
  primaryFileCount: 1,
  truncated: false,
  units: [{ mediaKind: 'ebook', title: 'Book', contentFileCount: 1, totalFileCount: 1, sizeBytes: 1024 }],
  unitCount: 1,
  ignoredFileCount: 0,
  containerCount: 0,
  selection: null,
}

describe('useReleasePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearReleaseSearchCache()
    apiMock.mockResolvedValue(ok(inspection))
  })

  /**
   * A source that does not carry the requested medium is never searched, so it arrives as a count
   * rather than as a failed indexer. The picker needs it to tell "nothing you have configured
   * carries this" apart from "the search found nothing".
   */
  it('carries the count of sources that were never searched for this medium', async () => {
    apiMock.mockResolvedValue(
      sse({
        releases: [],
        criteria: {
          title: 'Dune',
          authors: ['Frank Herbert'],
          isbn10: null,
          isbn13: null,
          activeIsbn: null,
          isbns: [],
          mediaKind: 'ebook',
          language: null,
          preferredFormats: ['epub'],
        },
        indexers: [],
        uncoveredIndexerCount: 2,
        cached: false,
      }),
    )
    const picker = useReleasePicker(() => true)

    await picker.fetchReleases(42)

    expect(picker.uncoveredIndexerCount.value).toBe(2)
    expect(picker.indexers.value).toEqual([])
    expect(picker.criteria.value?.authors).toEqual(['Frank Herbert'])
  })

  /**
   * Both counts, because zero enabled sources and zero configured sources need opposite fixes and
   * the search result is the only place the picker can learn either: the indexer list is admin-only.
   */
  it('carries how many sources were enabled and how many exist at all', async () => {
    apiMock.mockResolvedValue(sse(searchResult({ enabledIndexerCount: 0, configuredIndexerCount: 3 })))
    const picker = useReleasePicker(() => true)

    await picker.fetchReleases(42)

    expect(picker.enabledIndexerCount.value).toBe(0)
    expect(picker.configuredIndexerCount.value).toBe(3)
  })

  it('posts explicit manual search fields to the scoped fulfillment endpoint', async () => {
    apiMock.mockResolvedValue(
      sse({
        releases: [],
        criteria: {
          title: 'Dune Messiah',
          authors: ['Frank Herbert'],
          isbn10: null,
          isbn13: '9780593098233',
          activeIsbn: '9780593098233',
          isbns: ['9780593098233'],
          mediaKind: 'ebook',
          language: null,
          preferredFormats: ['azw3'],
        },
        indexers: [],
        uncoveredIndexerCount: 0,
        profileActive: false,
        cached: false,
      }),
    )
    const picker = useReleasePicker(() => true)
    const overrides = {
      title: 'Dune Messiah',
      authors: ['Frank Herbert'],
      isbn: '9780593098233',
      language: null,
      preferredFormats: ['azw3'],
    }

    await expect(picker.fetchReleases(42, { overrides })).resolves.toBe(true)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/book-requests/42/releases/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
      signal: expect.anything(),
    })
    expect(picker.criteria.value?.isbns).toEqual(['9780593098233'])
  })

  it('forgets the uncovered count and everything it searched when the picker is reset', async () => {
    apiMock.mockResolvedValue(sse(searchResult({ uncoveredIndexerCount: 2 })))
    const picker = useReleasePicker(() => true)
    await picker.fetchReleases(42)

    picker.reset()

    expect(picker.uncoveredIndexerCount.value).toBe(0)
    expect(picker.enabledIndexerCount.value).toBe(0)
    expect(picker.configuredIndexerCount.value).toBe(0)
    expect(picker.criteria.value).toBeNull()
    expect(picker.attempts.value.size).toBe(0)
  })

  /**
   * Alternate ISBNs on one request almost always share a provider label, so "Google Books" four
   * times separates nothing. What each key returned is the only thing that does.
   */
  it('remembers how many releases every key it searched came back with', async () => {
    const picker = useReleasePicker(() => true)

    apiMock.mockResolvedValue(sse(searchResult({ activeIsbn: '9781234567897', releases: [release, release] })))
    await picker.fetchReleases(42)
    apiMock.mockResolvedValue(sse(searchResult({ activeIsbn: '9781250301697' })))
    await picker.fetchReleases(42, { overrides: { isbn: '9781250301697' } })

    expect(picker.attempts.value.get('9781234567897')).toBe(2)
    expect(picker.attempts.value.get('9781250301697')).toBe(0)
  })

  it('keys a title and author search by name, since it has no ISBN to be keyed by', async () => {
    apiMock.mockResolvedValue(sse(searchResult({ activeIsbn: null, releases: [release] })))
    const picker = useReleasePicker(() => true)

    await picker.fetchReleases(42, { overrides: { isbn: null } })

    expect(picker.attempts.value.get(TITLE_AUTHOR_SEARCH_KEY)).toBe(1)
  })

  it('inspects only the selected release without sending source URLs to the browser', async () => {
    const picker = useReleasePicker(() => true)

    await expect(picker.inspectRelease(42, release)).resolves.toEqual(inspection)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/book-requests/42/releases/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexerId: 9, releaseGuid: 'release-guid' }),
    })
    expect(picker.inspections.value.get('9:release-guid')).toEqual(inspection)
  })

  it('reuses an inspection until search results are refreshed', async () => {
    const picker = useReleasePicker(() => true)

    await picker.inspectRelease(42, release)
    await picker.inspectRelease(42, release)

    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('shares one request when inspection is requested twice at the same time', async () => {
    let resolveInspection!: (response: Response) => void
    apiMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveInspection = resolve
      }),
    )
    const picker = useReleasePicker(() => true)

    const first = picker.inspectRelease(42, release)
    const second = picker.inspectRelease(42, release)
    resolveInspection(ok(inspection))

    await expect(first).resolves.toEqual(inspection)
    await expect(second).resolves.toEqual(inspection)
    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('discards an inspection that finishes after search results refresh', async () => {
    let resolveInspection!: (response: Response) => void
    apiMock.mockImplementation((url) => {
      if (url.endsWith('/releases/inspect')) {
        return new Promise<Response>((resolve) => {
          resolveInspection = resolve
        })
      }
      return Promise.resolve(sse(searchResult({})))
    })
    const picker = useReleasePicker(() => true)

    const staleInspection = picker.inspectRelease(42, release)
    await picker.fetchReleases(42, { refresh: true })
    resolveInspection(ok(inspection))

    await expect(staleInspection).resolves.toBeNull()
    expect(picker.inspections.value.size).toBe(0)
  })

  it('records a failed inspection and does not invent a manifest', async () => {
    apiMock.mockResolvedValue({ ok: false, status: 502, json: async () => null } as unknown as Response)
    const picker = useReleasePicker(() => true)

    await expect(picker.inspectRelease(42, release)).resolves.toBeNull()

    expect(picker.inspections.value.size).toBe(0)
    expect(picker.inspectionFailed.value.has('9:release-guid')).toBe(true)
  })

  /**
   * The tracker's own sentence is the useful half of a refusal, and it used to be dropped on the
   * floor in favour of "could not read this release's file list".
   */
  it('keeps the reason a refusal came with', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'VIP torrent and you are not VIP or higher' }),
    } as unknown as Response)
    const picker = useReleasePicker(() => true)

    await picker.inspectRelease(42, release)

    expect(picker.inspectionFailed.value.get('9:release-guid')).toBe('VIP torrent and you are not VIP or higher')
  })

  it('joins a list of validation messages into one reason', async () => {
    apiMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: ['first', 'second'] }) } as unknown as Response)
    const picker = useReleasePicker(() => true)

    await picker.inspectRelease(42, release)

    expect(picker.inspectionFailed.value.get('9:release-guid')).toBe('first. second')
  })

  /** A transport failure has no sentence to pass on, and must not read as one. */
  it('records no reason when the request never reached the server', async () => {
    apiMock.mockRejectedValue(new Error('offline'))
    const picker = useReleasePicker(() => true)

    await picker.inspectRelease(42, release)

    expect(picker.inspectionFailed.value.has('9:release-guid')).toBe(true)
    expect(picker.inspectionFailed.value.get('9:release-guid')).toBeNull()
  })

  it('clears a previous reason when the same release is inspected again', async () => {
    apiMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: 'refused' }) } as unknown as Response)
    const picker = useReleasePicker(() => true)
    await picker.inspectRelease(42, release)

    apiMock.mockResolvedValue(ok(inspection))
    picker.reset()
    await picker.inspectRelease(42, release)

    expect(picker.inspectionFailed.value.has('9:release-guid')).toBe(false)
  })
})

/**
 * A cross-indexer search can take the better part of a minute, which is long enough for the
 * approver to search again with different terms, or to leave for another request entirely.
 */
describe('useReleasePicker out-of-order searches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.mockReset()
    clearReleaseSearchCache()
  })

  function deferred() {
    let release: (body: unknown) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = (body: unknown) => resolve(sse(body))
    })
    return { pending, release }
  }

  it('does not let an older search overwrite the results of a newer one', async () => {
    const picker = useReleasePicker(() => true)
    const older = deferred()
    const newest = [{ indexerId: 1, guid: 'newest' } as ReleaseCandidateItem]
    apiMock.mockImplementationOnce(() => older.pending)
    apiMock.mockResolvedValueOnce(sse(searchResult({ releases: newest })))

    const stale = picker.fetchReleases(7)
    await picker.fetchReleases(7, { refresh: true })
    older.release(searchResult({ releases: [{ indexerId: 2, guid: 'stale' } as ReleaseCandidateItem] }))

    await expect(stale).resolves.toBe(false)
    expect(picker.releases.value).toEqual(newest)
    expect(picker.loading.value).toBe(false)
  })

  /** Closing the picker resets it, and an answer arriving afterwards is about a request nobody has open. */
  it('does not repopulate a picker that has been reset', async () => {
    const picker = useReleasePicker(() => true)
    const older = deferred()
    apiMock.mockImplementationOnce(() => older.pending)

    const stale = picker.fetchReleases(7)
    picker.reset()
    older.release(searchResult({ releases: [{ indexerId: 2, guid: 'stale' } as ReleaseCandidateItem] }))
    await stale

    expect(picker.releases.value).toEqual([])
    expect(picker.searched.value).toBe(false)
  })

  /** The picker for a pair searches both halves on open, and the trackers must only be asked once. */
  describe('a default search shared across pickers', () => {
    it('answers from a search already started ahead of time instead of asking again', async () => {
      const found = deferred()
      apiMock.mockImplementationOnce(() => found.pending)
      prefetchReleaseSearch(true, 11)
      const picker = useReleasePicker(() => true)

      const loaded = picker.fetchReleases(11)
      found.release(searchResult({ releases: [release] }))

      await expect(loaded).resolves.toBe(true)
      expect(apiMock).toHaveBeenCalledTimes(1)
      expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/book-requests/11/releases/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(picker.releases.value).toEqual([release])
    })

    it('shows a search it already has in the same tick, without a loading state', async () => {
      apiMock.mockResolvedValue(sse(searchResult({ releases: [release, release] })))
      await useReleasePicker(() => true).fetchReleases(11)
      const picker = useReleasePicker(() => true)

      void picker.fetchReleases(11)

      expect(picker.releases.value).toHaveLength(2)
      expect(picker.loading.value).toBe(false)
      // A list shown again from memory is one already searched, and the note says so.
      expect(picker.cached.value).toBe(true)
      expect(apiMock).toHaveBeenCalledTimes(1)
    })

    it('shows the list last on screen when a half is opened again, a changed search included', async () => {
      apiMock.mockResolvedValueOnce(sse(searchResult({ releases: [release] })))
      const first = useReleasePicker(() => true)
      await first.fetchReleases(11)
      const narrowed = [{ indexerId: 3, guid: 'narrowed' } as ReleaseCandidateItem]
      apiMock.mockResolvedValueOnce(sse(searchResult({ activeIsbn: '9781250301697', releases: narrowed })))
      await first.fetchReleases(11, { overrides: { isbn: '9781250301697' } })

      const again = useReleasePicker(() => true)
      void again.fetchReleases(11)

      expect(again.releases.value).toEqual(narrowed)
      expect(apiMock).toHaveBeenCalledTimes(2)
    })

    it('asks the trackers again when the search is refreshed', async () => {
      apiMock.mockResolvedValue(sse(searchResult({ releases: [release] })))
      const picker = useReleasePicker(() => true)
      await picker.fetchReleases(11)

      await picker.fetchReleases(11, { refresh: true })

      expect(apiMock).toHaveBeenLastCalledWith('/api/v1/admin/book-requests/11/releases/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: true }),
      })
      expect(apiMock).toHaveBeenCalledTimes(2)
    })

    it('says a search is running, then how many releases it found', async () => {
      const found = deferred()
      apiMock.mockImplementationOnce(() => found.pending)

      prefetchReleaseSearch(true, 11)
      expect(peekReleaseSearch(true, 11)).toEqual({ searching: true, count: null })

      found.release(searchResult({ releases: [release, release, release] }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(peekReleaseSearch(true, 11)).toEqual({ searching: false, count: 3 })
    })

    it('forgets a failed search, so the next look asks again', async () => {
      apiMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as Response)
      prefetchReleaseSearch(true, 11)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(peekReleaseSearch(true, 11)).toEqual({ searching: false, count: null })

      apiMock.mockResolvedValueOnce(sse(searchResult({ releases: [release] })))
      await useReleasePicker(() => true).fetchReleases(11)
      expect(apiMock).toHaveBeenCalledTimes(2)
    })

    it('keeps a self-fulfiller and a moderator apart, since they search different endpoints', async () => {
      apiMock.mockResolvedValue(sse(searchResult({ releases: [release] })))
      prefetchReleaseSearch(true, 11)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(peekReleaseSearch(false, 11)).toEqual({ searching: false, count: null })
    })
  })
})

/**
 * A streamed search answers several times: one merged snapshot per source that finishes, then the
 * final result. The picker must render each snapshot as the list so far without ever letting one
 * claim the search is over.
 */
describe('useReleasePicker streamed search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.mockReset()
    clearReleaseSearchCache()
  })

  /** A snapshot is the final result's shape plus the sources still answering. */
  function progressOf(result: ReturnType<typeof searchResult>, pending: unknown[]): unknown {
    return { ...result, pending }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('applies each snapshot as it arrives and only the final result settles the search', async () => {
    const feed = handFedStream()
    apiMock.mockResolvedValueOnce(feed.response)
    const picker = useReleasePicker(() => true)

    const loaded = picker.fetchReleases(42)
    await settle()
    expect(picker.loading.value).toBe(true)
    expect(picker.releases.value).toEqual([])

    feed.sendProgress(progressOf(searchResult({ releases: [release] }), [{ indexerId: 3, indexerName: 'Slow', color: null }]))
    await settle()

    expect(picker.releases.value).toEqual([release])
    expect(picker.pendingIndexers.value).toEqual([{ indexerId: 3, indexerName: 'Slow', color: null }])
    // Only the final result may say the search is over, or the empty states flash mid-search.
    expect(picker.loading.value).toBe(true)
    expect(picker.searched.value).toBe(false)
    expect(picker.attempts.value.size).toBe(0)

    feed.sendResult(searchResult({ releases: [release, release] }))
    await expect(loaded).resolves.toBe(true)

    expect(picker.releases.value).toHaveLength(2)
    expect(picker.pendingIndexers.value).toEqual([])
    expect(picker.searched.value).toBe(true)
    expect(picker.attempts.value.get(TITLE_AUTHOR_SEARCH_KEY)).toBe(2)
  })

  it('ignores a snapshot and a result from a search a newer one replaced', async () => {
    const stale = handFedStream()
    const fresh = handFedStream()
    apiMock.mockImplementationOnce(() => Promise.resolve(stale.response)).mockImplementationOnce(() => Promise.resolve(fresh.response))
    const picker = useReleasePicker(() => true)

    const first = picker.fetchReleases(42, { overrides: { isbn: '9781234567897' } })
    await settle()
    const second = picker.fetchReleases(42, { overrides: { isbn: '9781250301697' } })
    await settle()

    stale.sendProgress(progressOf(searchResult({ releases: [release] }), [{ indexerId: 3, indexerName: 'Slow', color: null }]))
    stale.sendResult(searchResult({ releases: [release] }))
    fresh.sendResult(searchResult({ releases: [{ indexerId: 2, guid: 'fresh' } as ReleaseCandidateItem] }))
    await Promise.all([first, second])

    expect(picker.releases.value).toEqual([{ indexerId: 2, guid: 'fresh' }])
    expect(picker.pendingIndexers.value).toEqual([])
    expect(picker.loading.value).toBe(false)
  })

  it('cuts a custom search short when a newer search starts', async () => {
    const stale = handFedStream()
    const fresh = handFedStream()
    apiMock.mockImplementationOnce(() => Promise.resolve(stale.response)).mockImplementationOnce(() => Promise.resolve(fresh.response))
    const picker = useReleasePicker(() => true)

    void picker.fetchReleases(42, { overrides: { isbn: '9781234567897' } })
    await settle()
    const staleSignal = apiMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(staleSignal.aborted).toBe(false)

    void picker.fetchReleases(42)
    await settle()
    expect(staleSignal.aborted).toBe(true)

    fresh.sendResult(searchResult({}))
    stale.close()
    await settle()
  })

  it('hands a picker that opens mid-search the snapshots already sent', async () => {
    const feed = handFedStream()
    apiMock.mockImplementationOnce(() => Promise.resolve(feed.response))
    prefetchReleaseSearch(true, 11)
    await settle()

    feed.sendProgress(progressOf(searchResult({ releases: [release] }), [{ indexerId: 3, indexerName: 'Slow', color: null }]))
    await settle()

    const picker = useReleasePicker(() => true)
    void picker.fetchReleases(11)
    await settle()

    // The latest snapshot was replayed to the late picker without a second request.
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(picker.releases.value).toEqual([release])
    expect(picker.pendingIndexers.value).toEqual([{ indexerId: 3, indexerName: 'Slow', color: null }])
    expect(picker.loading.value).toBe(true)

    feed.sendResult(searchResult({ releases: [release] }))
    await settle()
    expect(picker.searched.value).toBe(true)
    expect(picker.pendingIndexers.value).toEqual([])
  })

  it('forgets the sources still answering when the picker is reset', async () => {
    const feed = handFedStream()
    apiMock.mockImplementationOnce(() => Promise.resolve(feed.response))
    const picker = useReleasePicker(() => true)
    void picker.fetchReleases(42)
    await settle()

    feed.sendProgress(progressOf(searchResult({ releases: [release] }), [{ indexerId: 3, indexerName: 'Slow', color: null }]))
    await settle()
    expect(picker.pendingIndexers.value).toHaveLength(1)

    picker.reset()
    expect(picker.pendingIndexers.value).toEqual([])

    feed.close()
    await settle()
  })
})
