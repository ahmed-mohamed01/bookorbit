import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { EditionSyncBookListItem, EditionSyncBookListQuery, EditionSyncBookListResponse, EditionSyncBookState } from '@bookorbit/types'
import { editionSyncState } from '@/features/book/lib/__tests__/sync-fixtures'

const mocks = vi.hoisted(() => ({
  fetchBooks: vi.fn<(query: EditionSyncBookListQuery) => Promise<EditionSyncBookListResponse>>(),
  update: vi.fn<(bookId: number, payload: { syncEnabled: boolean }) => Promise<EditionSyncBookState>>(),
  run: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retry: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retryFailed: vi.fn<() => Promise<{ retried: number }>>(),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncBooks: mocks.fetchBooks,
  updateEditionSyncBookState: mocks.update,
  runEditionSyncBookNow: mocks.run,
  retryEditionSyncBook: mocks.retry,
  retryFailedEditionSyncBooks: mocks.retryFailed,
}))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

import {
  applyBookState,
  EDITION_SYNC_BOOKS_REFRESH_MS,
  EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS,
  useEditionSyncBooks,
  type UseEditionSyncBooksOptions,
} from '../useEditionSyncBooks'
import { bookItem as fixtureBookItem } from '../../lib/__tests__/list-fixtures'
import { useEditionSyncSettings } from '../useEditionSyncSettings'

function bookItem(overrides: Partial<EditionSyncBookListItem> = {}): EditionSyncBookListItem {
  return fixtureBookItem({ coverVersion: null, status: 'queued', indexedAt: null, canRunNow: true, ...overrides })
}

function response(overrides: Partial<EditionSyncBookListResponse> = {}): EditionSyncBookListResponse {
  return {
    items: [bookItem()],
    total: 1,
    page: 1,
    pageSize: 50,
    counts: { all: 1, problems: 0, queued: 1, synced: 0, off: 0 },
    disabledReason: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

let scope = effectScope()

function setup(options: UseEditionSyncBooksOptions = {}) {
  scope = effectScope()
  return scope.run(() => useEditionSyncBooks(options))!
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useEditionSyncBooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchBooks.mockResolvedValue(response())
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('loads the first page of every book with the counts', async () => {
    const books = setup()
    await books.load()
    expect(mocks.fetchBooks).toHaveBeenCalledWith({ filter: 'all', q: undefined, page: 1 })
    expect(books.items.value).toHaveLength(1)
    expect(books.counts.value?.queued).toBe(1)
    expect(books.range.value).toEqual({ from: 1, to: 1, total: 1 })
    expect(books.loaded.value).toBe(true)
    expect(books.loading.value).toBe(false)
  })

  it('switches filters from the first page', async () => {
    const books = setup()
    mocks.fetchBooks.mockResolvedValue(response({ total: 120, items: Array.from({ length: 50 }, (_, i) => bookItem({ bookId: i })) }))
    await books.load()
    books.nextPage()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS)
    expect(books.page.value).toBe(2)
    expect(books.range.value).toEqual({ from: 51, to: 100, total: 120 })

    books.setFilter('problems')
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS)
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'problems', q: undefined, page: 1 })
  })

  it('debounces the search by 300 ms and trims it', async () => {
    const books = setup()
    books.setQuery(' wind')
    books.setQuery(' wind and ')
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS - 1)
    expect(mocks.fetchBooks).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
    expect(mocks.fetchBooks).toHaveBeenCalledWith({ filter: 'all', q: 'wind and', page: 1 })
  })

  it('keeps only the latest answer when responses land out of order', async () => {
    const books = setup()
    const slow = deferred<EditionSyncBookListResponse>()
    mocks.fetchBooks.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(response({ items: [bookItem({ bookId: 2, title: 'New' })] }))
    const first = books.load()
    books.setFilter('off')
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS)
    slow.resolve(response({ items: [bookItem({ bookId: 1, title: 'Old' })] }))
    await first
    expect(books.items.value.map((item) => item.title)).toEqual(['New'])
  })

  it('falls back to the last page when the current one is past the end', async () => {
    const books = setup()
    books.page.value = 3
    mocks.fetchBooks.mockResolvedValueOnce(response({ items: [], total: 60 })).mockResolvedValueOnce(response({ total: 60, page: 2 }))
    await books.load()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS)
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'all', q: undefined, page: 2 })
    expect(books.page.value).toBe(2)
  })

  it('shows a failed load', async () => {
    mocks.fetchBooks.mockRejectedValue(new Error(''))
    const books = setup()
    await books.load()
    expect(books.error.value).toBe('Failed to load the books.')
  })

  it('updates a row from the state a toggle, run or retry answers with, then re-fetches the page and counts', async () => {
    const books = setup()
    await books.load()
    books.setFilter('queued')
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    mocks.fetchBooks.mockClear()

    const refetch = deferred<EditionSyncBookListResponse>()
    mocks.fetchBooks.mockReturnValueOnce(refetch.promise)
    mocks.update.mockResolvedValue(editionSyncState({}, { bookId: 7, syncEnabled: false }))
    await books.setSyncEnabled(7, false)
    expect(mocks.update).toHaveBeenCalledWith(7, { syncEnabled: false })
    expect(books.items.value[0]).toMatchObject({ syncEnabled: false, status: 'off' })
    expect(mocks.fetchBooks).toHaveBeenCalledWith({ filter: 'queued', q: undefined, page: 1 })

    refetch.resolve(response({ items: [], total: 0, counts: { all: 1, problems: 0, queued: 0, synced: 0, off: 1 } }))
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    expect(books.items.value).toEqual([])
    expect(books.counts.value).toMatchObject({ queued: 0, off: 1 })

    mocks.fetchBooks.mockResolvedValue(response())
    await books.load()
    mocks.run.mockResolvedValue(editionSyncState({ status: 'running', stage: 'aligning', progress: 5 }))
    mocks.fetchBooks.mockReturnValueOnce(new Promise(() => {}))
    await books.runNow(7)
    expect(books.items.value[0]).toMatchObject({ syncEnabled: true, status: 'running', stage: 'aligning', progress: 5 })

    mocks.fetchBooks.mockClear()
    mocks.retry.mockRejectedValue(new Error('nope'))
    expect(await books.retry(7)).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith('nope')
    expect(mocks.fetchBooks).not.toHaveBeenCalled()
    expect(books.pendingIds.value.size).toBe(0)
  })

  it('drops a re-fetch that a later one overtook', async () => {
    const books = setup()
    await books.load()
    const first = deferred<EditionSyncBookListResponse>()
    const second = deferred<EditionSyncBookListResponse>()
    mocks.fetchBooks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    mocks.update.mockResolvedValue(editionSyncState({}, { bookId: 7, syncEnabled: false }))
    await books.setSyncEnabled(7, false)
    mocks.run.mockResolvedValue(editionSyncState({ status: 'running', stage: 'aligning', progress: 5 }))
    await books.runNow(7)

    second.resolve(response({ counts: { all: 1, problems: 0, queued: 1, synced: 0, off: 0 }, items: [bookItem({ status: 'running' })] }))
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    first.resolve(response({ counts: { all: 1, problems: 0, queued: 0, synced: 0, off: 1 }, items: [bookItem({ status: 'off' })] }))
    await Promise.resolve()
    await Promise.resolve()
    expect(books.items.value[0].status).toBe('running')
    expect(books.counts.value?.off).toBe(0)
  })

  it('caps the search at 200 characters', () => {
    const books = setup()
    books.setQuery('x'.repeat(250))
    expect(books.query.value).toHaveLength(200)
  })

  it.each([
    ['all_eligible', null, true],
    ['all_eligible', 'included', true],
    ['all_eligible', 'excluded', false],
    ['selected_only', null, false],
    ['selected_only', 'included', true],
    ['selected_only', 'excluded', false],
  ] as const)('shows the stored choice while the account sync is off (%s, override %s)', async (bookSyncMode, syncOverride, expected) => {
    useEditionSyncSettings().settings.value = { enabled: false, effectiveEnabled: false, disabledReason: 'user_disabled', bookSyncMode }
    const item = bookItem({ syncEnabled: false, status: 'off', syncOverride })
    mocks.fetchBooks.mockResolvedValue(response({ items: [item], disabledReason: 'user_disabled' }))
    const books = setup()
    await books.load()
    expect(books.toggleValue(item)).toBe(expected)
    expect(books.canToggle(item)).toBe(true)
    useEditionSyncSettings().settings.value = null
  })

  it('follows the row value while sync is on and locks the switch while the server is off', async () => {
    const books = setup()
    await books.load()
    expect(books.toggleValue(bookItem({ syncEnabled: false, syncOverride: null }))).toBe(false)
    expect(books.canToggle(bookItem())).toBe(true)
    mocks.fetchBooks.mockResolvedValue(response({ disabledReason: 'server_disabled' }))
    await books.load()
    expect(books.canToggle(bookItem())).toBe(false)
  })

  it('takes only the reliable fields from a book state and clears details of the old status', () => {
    const failed = bookItem({
      status: 'failed',
      error: 'old',
      errorCode: 'worker_crashed',
      lastAttemptAt: '2026-11-01T03:00:00.000Z',
      canRetry: true,
    })
    const row = applyBookState(
      failed,
      editionSyncState({ status: 'queued', error: 'from state', queuePosition: 3, attemptCount: 9 }, { canRetry: false, canRunNow: true }),
    )
    expect(row).toMatchObject({ status: 'queued', error: null, errorCode: null, lastAttemptAt: null, invalidatedReason: null, queuePosition: null })
    expect(row).toMatchObject({ canRunNow: true, canRetry: false, attemptCount: 0 })

    const queued = bookItem({ status: 'queued', queuePosition: 4, invalidatedReason: 'yielded' })
    const pinned = applyBookState(queued, editionSyncState({ status: 'queued', queuePosition: 1 }))
    expect(pinned).toMatchObject({ status: 'queued', invalidatedReason: 'yielded', queuePosition: null })
  })

  it('marks an acted-on row as waiting for details until the re-fetch lands', async () => {
    const books = setup()
    await books.load()
    const refetch = deferred<EditionSyncBookListResponse>()
    mocks.fetchBooks.mockReturnValueOnce(refetch.promise)
    mocks.run.mockResolvedValue(editionSyncState({ status: 'queued' }))
    await books.runNow(7)
    expect(books.detailsPendingIds.value.has(7)).toBe(true)
    refetch.resolve(response())
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    expect(books.detailsPendingIds.value.size).toBe(0)
  })

  it('opens on Problems when anything failed, and stays on All otherwise', async () => {
    mocks.fetchBooks
      .mockResolvedValueOnce(response({ counts: { all: 3, problems: 2, queued: 1, synced: 0, off: 0 } }))
      .mockResolvedValueOnce(response({ counts: { all: 3, problems: 2, queued: 1, synced: 0, off: 0 } }))
    const books = setup()
    await books.load()
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    expect(books.filter.value).toBe('problems')
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'problems', q: undefined, page: 1 })

    scope.stop()
    mocks.fetchBooks.mockReset().mockResolvedValue(response({ items: [bookItem({ status: 'ready' })] }))
    const fresh = setup()
    await fresh.load()
    expect(fresh.filter.value).toBe('all')
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
  })

  it('keeps a tab the reader picked before the first answer', async () => {
    const first = deferred<EditionSyncBookListResponse>()
    mocks.fetchBooks.mockReturnValueOnce(first.promise).mockResolvedValue(response({ counts: { all: 3, problems: 2, queued: 1, synced: 0, off: 0 } }))
    const books = setup()
    void books.load()
    books.setFilter('synced')
    await vi.waitFor(() => expect(books.loading.value).toBe(false))
    expect(books.filter.value).toBe('synced')
  })

  it('retries every failed book, says how many, and reloads', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ status: 'ready' })] }))
    mocks.retryFailed.mockResolvedValue({ retried: 3 })
    const books = setup()
    await books.load()
    mocks.fetchBooks.mockClear()
    expect(await books.retryAllFailed()).toBe(true)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('3 books queued to retry')
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
    expect(books.retryingFailed.value).toBe(false)

    mocks.retryFailed.mockRejectedValue(new Error('Edition sync is off'))
    expect(await books.retryAllFailed()).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith('Edition sync is off')
  })

  it('re-fetches every 5 s while the page has running or queued rows, and stops when hidden or idle', async () => {
    const books = setup()
    await books.load()
    mocks.fetchBooks.mockClear()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS * 3)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await vi.waitFor(() => expect(mocks.fetchBooks).toHaveBeenCalledTimes(2))

    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ status: 'ready' })] }))
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS * 3)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(3)
  })

  it('keeps refreshing while the page has out-of-date rows', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ status: 'stale' })] }))
    const books = setup()
    await books.load()
    mocks.fetchBooks.mockClear()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
  })

  it('keeps refreshing an idle page while an admin run is active', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ status: 'ready' })] }))
    const runActive = ref(false)
    const books = setup({ runActive })
    await books.load()
    mocks.fetchBooks.mockClear()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS * 2)
    expect(mocks.fetchBooks).not.toHaveBeenCalled()

    runActive.value = true
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)

    runActive.value = false
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS * 3)
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(2)
  })

  it('stops refreshing once disposed', async () => {
    const books = setup()
    await books.load()
    mocks.fetchBooks.mockClear()
    scope.stop()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_BOOKS_REFRESH_MS * 3)
    expect(mocks.fetchBooks).not.toHaveBeenCalled()
  })
})
