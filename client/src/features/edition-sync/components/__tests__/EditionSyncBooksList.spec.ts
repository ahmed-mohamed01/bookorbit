import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { EditionSyncBookListQuery, EditionSyncBookListResponse, EditionSyncBookState } from '@bookorbit/types'
import { editionSyncState } from '@/features/book/lib/__tests__/sync-fixtures'
import { bookItem, listResponse } from '../../lib/__tests__/list-fixtures'

const mocks = vi.hoisted(() => ({
  fetchBooks: vi.fn<(query: EditionSyncBookListQuery) => Promise<EditionSyncBookListResponse>>(),
  update: vi.fn<(bookId: number, payload: { syncEnabled: boolean }) => Promise<EditionSyncBookState>>(),
  run: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retry: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retryFailed: vi.fn<() => Promise<{ retried: number }>>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncBooks: mocks.fetchBooks,
  updateEditionSyncBookState: mocks.update,
  runEditionSyncBookNow: mocks.run,
  retryEditionSyncBook: mocks.retry,
  retryFailedEditionSyncBooks: mocks.retryFailed,
}))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

import EditionSyncBooksList from '../EditionSyncBooksList.vue'
import { useEditionSyncSettings } from '../../composables/useEditionSyncSettings'

enableAutoUnmount(afterEach)

const ITEMS = [
  bookItem({
    bookId: 1,
    title: 'The Calamitous Bob',
    status: 'failed',
    error: 'No audio stream found in chapter 12',
    errorCode: 'worker_crashed',
    attemptCount: 3,
    lastAttemptAt: '2026-11-01T03:00:00.000Z',
    canRetry: true,
    indexedAt: null,
  }),
  bookItem({ bookId: 2, title: 'The Way of Kings', status: 'queued', canRunNow: true, indexedAt: null, queuePosition: 4, invalidatedReason: null }),
  bookItem({ bookId: 3, title: 'Mistborn', status: 'running', stage: 'aligning', progress: 42, indexedAt: null }),
  bookItem({
    bookId: 4,
    title: 'Life, the Universe and Everything',
    sentences: 1000,
    matchedSentences: 980,
    workerVersion: '1.4.0',
    indexBytes: 2048,
  }),
  bookItem({ bookId: 5, title: 'Elantris', status: 'off', syncEnabled: false, syncOverride: 'excluded' }),
  bookItem({ bookId: 6, title: 'Warbreaker', status: 'stale', invalidatedReason: 'audio_changed', queuePosition: 9, canRunNow: true }),
]

function response(overrides: Partial<EditionSyncBookListResponse> = {}): EditionSyncBookListResponse {
  return listResponse({ items: ITEMS, total: 1248, counts: { all: 1248, problems: 0, queued: 12, synced: 1229, off: 4 }, ...overrides })
}

const RouterLinkStub = { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' }

async function mountList(props: { runActive?: boolean } = {}) {
  const wrapper = mount(EditionSyncBooksList, { props, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountList>>

function row(wrapper: Wrapper, index: number) {
  return wrapper.findAll('[data-testid="edition-sync-books-row"]')[index]!
}

async function expand(wrapper: Wrapper, index: number) {
  await row(wrapper, index).get('[data-testid="edition-sync-books-row-header"]').trigger('click')
}

function details(wrapper: Wrapper, index: number): Record<string, string> {
  return Object.fromEntries(
    row(wrapper, index)
      .findAll('[data-detail]')
      .map((entry) => [entry.attributes('data-detail')!, entry.get('dd').text()]),
  )
}

function actions(wrapper: Wrapper, index: number): string[] {
  return row(wrapper, index)
    .findAll('[data-testid="edition-sync-books-action"]')
    .map((button) => button.text())
}

describe('EditionSyncBooksList', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchBooks.mockResolvedValue(response())
  })

  afterEach(() => {
    useEditionSyncSettings().settings.value = null
  })

  it('shows the tabs as a tablist in order, with counts and a labelled search', async () => {
    const wrapper = await mountList()
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.text())).toEqual(['Problems 0', 'Queue 12', 'Synced 1,229', 'Off 4', 'All 1,248'])
    expect(wrapper.get('[data-filter="all"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-filter="problems"]').attributes('aria-selected')).toBe('false')
    const search = wrapper.get('[data-testid="edition-sync-books-search"]')
    expect(search.attributes('maxlength')).toBe('200')
    expect(wrapper.get(`label[for="${search.attributes('id')}"]`).text()).toBe('Search books')
  })

  it('opens on Problems with a muted count when anything failed, and retries all failed books', async () => {
    const counts = { all: 1248, problems: 3, queued: 12, synced: 1229, off: 4 }
    mocks.fetchBooks.mockResolvedValue(response({ counts, items: ITEMS.slice(0, 1) }))
    mocks.retryFailed.mockResolvedValue({ retried: 3 })
    const wrapper = await mountList()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'problems', q: undefined, page: 1 })
    expect(wrapper.get('[data-filter="problems"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-filter="problems"]').text()).toBe('Problems 3')
    expect(wrapper.get('[data-filter="problems"]').find('.rounded-full').exists()).toBe(false)
    const hint = wrapper.get('[data-testid="edition-sync-books-problems-hint"]')
    expect(hint.text()).toContain("3 books couldn't be indexed. Retrying puts them at the front of the queue.")

    mocks.fetchBooks.mockClear()
    await wrapper.get('[data-testid="edition-sync-books-retry-all"]').trigger('click')
    await flushPromises()
    expect(mocks.retryFailed).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('3 books queued to retry')
    expect(mocks.fetchBooks).toHaveBeenCalledWith({ filter: 'problems', q: undefined, page: 1 })
  })

  it('hides Retry all failed while the account sync is off', async () => {
    useEditionSyncSettings().settings.value = {
      enabled: false,
      effectiveEnabled: false,
      disabledReason: 'user_disabled',
      bookSyncMode: 'all_eligible',
    }
    mocks.fetchBooks.mockResolvedValue(
      response({ disabledReason: 'user_disabled', counts: { all: 1, problems: 1, queued: 0, synced: 0, off: 0 }, items: ITEMS.slice(0, 1) }),
    )
    const wrapper = await mountList()
    expect(wrapper.find('[data-testid="edition-sync-books-problems-hint"]').exists()).toBe(false)
  })

  it('shows the row header with title, formats, status and a bare icon only for problems', async () => {
    const wrapper = await mountList()
    const status = (index: number) => row(wrapper, index).get('[data-testid="edition-sync-books-status"]').text()
    expect(status(0)).toBe("Couldn't index")
    expect(status(1)).toBe('Queued #4')
    expect(status(2)).toMatch(/· 42\s?%$/)
    expect(status(3)).toBe('Synced')
    expect(status(4)).toBe('Off')
    expect(status(5)).toBe('Out of date')
    expect(row(wrapper, 0).text()).toContain('M4B · EPUB')
    expect(row(wrapper, 0).get('img').attributes('src')).toContain('/api/v1/books/1/thumbnail')
    expect(row(wrapper, 0).find('svg.lucide-circle-alert, svg.lucide-alert-circle').exists()).toBe(true)
    expect(row(wrapper, 3).find('svg.lucide-circle-alert, svg.lucide-alert-circle').exists()).toBe(false)
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-row-header"]').attributes('aria-expanded')).toBe('false')
  })

  it('expands one row at a time', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 0)
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-row-header"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('[data-testid="edition-sync-books-panel"]')).toHaveLength(1)
    await expand(wrapper, 3)
    expect(row(wrapper, 0).find('[data-testid="edition-sync-books-panel"]').exists()).toBe(false)
    expect(row(wrapper, 3).find('[data-testid="edition-sync-books-panel"]').exists()).toBe(true)
    await expand(wrapper, 3)
    expect(wrapper.find('[data-testid="edition-sync-books-panel"]').exists()).toBe(false)
  })

  it('shows a failed book with its error, code, attempts and a Retry button', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 0)
    const facts = details(wrapper, 0)
    expect(facts.error).toBe('No audio stream found in chapter 12')
    expect(facts.code).toBe('worker_crashed')
    expect(facts.attempts).toMatch(/^3 · last tried /)
    expect(facts.positionSync).toBe('Not available until this is indexed')
    expect(actions(wrapper, 0)).toEqual(['Retry'])
    expect(JSON.parse(row(wrapper, 0).get('[data-testid="edition-sync-books-open"]').attributes('data-to')!)).toEqual({
      name: 'book-detail',
      params: { bookId: 1 },
    })

    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.retry.mockResolvedValue(editionSyncState({ status: 'running', stage: 'aligning', progress: 1 }, { bookId: 1 }))
    await row(wrapper, 0).get('[data-action="retry"]').trigger('click')
    await flushPromises()
    expect(mocks.retry).toHaveBeenCalledWith(1)
    expect(actions(wrapper, 0)).toEqual([])
  })

  it('drops the old details after a retry and shows the re-fetched ones', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 0)
    let resolveRefetch!: (value: EditionSyncBookListResponse) => void
    mocks.fetchBooks.mockClear().mockReturnValueOnce(new Promise((resolve) => (resolveRefetch = resolve)))
    mocks.retry.mockResolvedValue(editionSyncState({ status: 'queued', error: 'old', queuePosition: 2 }, { bookId: 1, canRunNow: true }))
    await row(wrapper, 0).get('[data-action="retry"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-status"]').text()).toBe('Queued')
    expect(details(wrapper, 0)).toEqual({})
    expect(row(wrapper, 0).text()).not.toContain('No audio stream found')
    expect(row(wrapper, 0).text()).not.toContain('Not indexed yet')

    const retried = bookItem({ bookId: 1, status: 'queued', invalidatedReason: 'interrupted', queuePosition: 1, canRunNow: true, indexedAt: null })
    resolveRefetch(response({ items: [retried, ...ITEMS.slice(1)] }))
    await flushPromises()
    expect(details(wrapper, 0)).toMatchObject({ placeInQueue: '#1' })
    expect(details(wrapper, 0).queuedBecause).not.toBe('Not indexed yet')
  })

  it('shows why a queued or out-of-date book waits, its place, and Run next', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 1)
    expect(details(wrapper, 1)).toEqual({ queuedBecause: 'Not indexed yet', placeInQueue: '#4' })
    expect(actions(wrapper, 1)).toEqual(['Run next', 'Turn off for this book'])
    mocks.fetchBooks.mockReturnValue(new Promise(() => {}))
    mocks.run.mockResolvedValue(editionSyncState({ status: 'running' }, { bookId: 2 }))
    await row(wrapper, 1).get('[data-action="run"]').trigger('click')
    expect(mocks.run).toHaveBeenCalledWith(2)

    await expand(wrapper, 5)
    expect(details(wrapper, 5)).toEqual({
      queuedBecause: 'The audiobook changed',
      placeInQueue: '#9',
      positionSync: 'Uses the previous index until then',
    })
  })

  it('says a queued book without a position is not in the run order yet', async () => {
    mocks.fetchBooks.mockResolvedValue(
      response({ items: [bookItem({ status: 'queued', queuePosition: null, invalidatedReason: 'yielded', indexedAt: null })] }),
    )
    const wrapper = await mountList()
    await expand(wrapper, 0)
    expect(details(wrapper, 0)).toEqual({ queuedBecause: 'Paused for another book', placeInQueue: 'Not in the run order yet' })
  })

  it('shows the stage and progress of a running book without actions', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 2)
    const facts = details(wrapper, 2)
    expect(facts.stage).toBeTruthy()
    expect(facts.progress).toMatch(/^42\s?%$/)
    expect(actions(wrapper, 2)).toEqual([])
  })

  it('shows the match, indexed date and size of a synced book', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 3)
    const facts = details(wrapper, 3)
    expect(facts.matched).toMatch(/^98\s?% of 1,000 sentences$/)
    expect(facts.indexed).toMatch(/· worker 1\.4\.0$/)
    expect(facts.indexSize).toMatch(/2/)
    expect(actions(wrapper, 3)).toEqual(['Turn off for this book'])
  })

  it('says why a book is off and turns it back on', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 4)
    expect(details(wrapper, 4)).toEqual({ why: 'You turned sync off for this book' })
    expect(actions(wrapper, 4)).toEqual(['Turn on sync'])

    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.update.mockResolvedValue(editionSyncState({ status: 'queued' }, { bookId: 5, syncEnabled: true }))
    await row(wrapper, 4).get('[data-action="toggle"]').trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith(5, { syncEnabled: true })
    expect(row(wrapper, 4).get('[data-testid="edition-sync-books-status"]').text()).toBe('Queued')
  })

  it('says a book is off because only selected books sync', async () => {
    useEditionSyncSettings().settings.value = { enabled: true, effectiveEnabled: true, disabledReason: null, bookSyncMode: 'selected_only' }
    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ status: 'off', syncEnabled: false, syncOverride: null })] }))
    const wrapper = await mountList()
    await expand(wrapper, 0)
    expect(details(wrapper, 0)).toEqual({ why: "Only selected books sync, and this one isn't selected" })
  })

  it('shows and changes the stored per-book choice while edition sync is off for the account', async () => {
    useEditionSyncSettings().settings.value = {
      enabled: false,
      effectiveEnabled: false,
      disabledReason: 'user_disabled',
      bookSyncMode: 'all_eligible',
    }
    const off = { status: 'off' as const, syncEnabled: false, canRunNow: false, canRetry: false }
    mocks.fetchBooks.mockResolvedValue(
      response({
        disabledReason: 'user_disabled',
        items: [bookItem({ bookId: 1, ...off, syncOverride: null }), bookItem({ bookId: 2, ...off, syncOverride: 'excluded' })],
      }),
    )
    const wrapper = await mountList()
    expect(wrapper.find('[data-testid="edition-sync-books-user-off"]').exists()).toBe(true)
    await expand(wrapper, 0)
    expect(details(wrapper, 0)).toEqual({ why: 'Your edition sync is off' })
    expect(actions(wrapper, 0)).toEqual(['Turn off for this book'])
    await expand(wrapper, 1)
    expect(actions(wrapper, 1)).toEqual(['Turn on sync'])

    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.update.mockResolvedValue(
      editionSyncState({ status: 'none' }, { bookId: 2, syncEnabled: false, syncOverride: null, effectiveReason: 'user_disabled' }),
    )
    await row(wrapper, 1).get('[data-action="toggle"]').trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith(2, { syncEnabled: true })
    expect(actions(wrapper, 1)).toEqual(['Turn off for this book'])
  })

  it('disables the on/off action while edition sync is off for the server', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ disabledReason: 'server_disabled' }))
    const wrapper = await mountList()
    await expand(wrapper, 4)
    expect(row(wrapper, 4).get('[data-action="toggle"]').attributes('disabled')).toBeDefined()
  })

  it('numbers the Queue tab in run order, without a number for the running book', async () => {
    const wrapper = await mountList()
    mocks.fetchBooks.mockResolvedValue(
      response({ items: [ITEMS[2]!, bookItem({ bookId: 8, status: 'queued', queuePosition: 1, indexedAt: null }), ITEMS[1]!] }),
    )
    await wrapper.get('[data-filter="queued"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'queued', q: undefined, page: 1 })
    expect(wrapper.get('[data-testid="edition-sync-books-queue-hint"]').text()).toBe('In the order they will run.')
    const positions = wrapper.findAll('[data-testid="edition-sync-books-position"]').map((cell) => cell.text())
    expect(positions).toEqual(['', '1', '4'])
    expect(row(wrapper, 2).get('[data-testid="edition-sync-books-status"]').text()).toBe('Queued')
  })

  it('keeps the expanded row across a refresh of the page', async () => {
    const wrapper = await mountList()
    await expand(wrapper, 3)
    mocks.fetchBooks.mockResolvedValue(response({ items: [bookItem({ bookId: 99, title: 'New' }), ...ITEMS] }))
    await (wrapper.vm as unknown as { load: () => Promise<void> }).load()
    await flushPromises()
    expect(row(wrapper, 4).text()).toContain('Life, the Universe and Everything')
    expect(row(wrapper, 4).find('[data-testid="edition-sync-books-panel"]').exists()).toBe(true)
  })

  it('pages with Previous and Next and shows the range', async () => {
    const wrapper = await mountList()
    expect(wrapper.get('[data-testid="edition-sync-books-range"]').text()).toBe('1-6 of 1,248')
    expect(wrapper.get('[data-testid="edition-sync-books-previous"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="edition-sync-books-next"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'all', q: undefined, page: 2 })
  })

  it('says when nothing matches', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ items: [], total: 0 }))
    const wrapper = await mountList()
    expect(wrapper.get('[data-testid="edition-sync-books-empty"]').text()).toBe('No books match.')
    expect(wrapper.find('[data-testid="edition-sync-books-range"]').exists()).toBe(false)
  })
})
