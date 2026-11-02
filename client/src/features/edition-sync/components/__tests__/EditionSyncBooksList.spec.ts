import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { EditionSyncBookListItem, EditionSyncBookListQuery, EditionSyncBookListResponse, EditionSyncBookState } from '@bookorbit/types'
import { editionSyncState } from '@/features/book/lib/__tests__/sync-fixtures'

const mocks = vi.hoisted(() => ({
  fetchBooks: vi.fn<(query: EditionSyncBookListQuery) => Promise<EditionSyncBookListResponse>>(),
  update: vi.fn<(bookId: number, payload: { syncEnabled: boolean }) => Promise<EditionSyncBookState>>(),
  run: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retry: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
}))

vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncBooks: mocks.fetchBooks,
  updateEditionSyncBookState: mocks.update,
  runEditionSyncBookNow: mocks.run,
  retryEditionSyncBook: mocks.retry,
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>() } }))

import EditionSyncBooksList from '../EditionSyncBooksList.vue'
import { useEditionSyncSettings } from '../../composables/useEditionSyncSettings'

function bookItem(overrides: Partial<EditionSyncBookListItem> = {}): EditionSyncBookListItem {
  return {
    bookId: 7,
    title: 'Wind and Truth',
    coverVersion: 'v2',
    formats: ['m4b', 'epub'],
    syncEnabled: true,
    syncOverride: null,
    status: 'ready',
    stage: null,
    progress: null,
    indexedAt: '2026-11-01T02:00:00.000Z',
    error: null,
    whisperFallback: false,
    canRunNow: false,
    canRetry: false,
    ...overrides,
  }
}

const ITEMS = [
  bookItem({ bookId: 1, title: 'The Calamitous Bob', status: 'failed', error: 'No audio stream found in chapter 12', canRetry: true }),
  bookItem({ bookId: 2, title: 'The Way of Kings', status: 'queued', canRunNow: true, indexedAt: null }),
  bookItem({ bookId: 3, title: 'Mistborn', status: 'running', stage: 'aligning', progress: 42, indexedAt: null }),
  bookItem({ bookId: 4, title: 'Life, the Universe and Everything' }),
  bookItem({ bookId: 5, title: 'Elantris', status: 'off', syncEnabled: false }),
]

function response(overrides: Partial<EditionSyncBookListResponse> = {}): EditionSyncBookListResponse {
  return {
    items: ITEMS,
    total: 1248,
    page: 1,
    pageSize: 50,
    counts: { all: 1248, problems: 3, queued: 12, synced: 1229, off: 4 },
    disabledReason: null,
    ...overrides,
  }
}

const RouterLinkStub = { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' }

async function mountList() {
  const wrapper = mount(EditionSyncBooksList, { global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

function row(wrapper: Awaited<ReturnType<typeof mountList>>, index: number) {
  return wrapper.findAll('[data-testid="edition-sync-books-row"]')[index]!
}

describe('EditionSyncBooksList', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.fetchBooks.mockResolvedValue(response())
  })

  it('shows the filters with their counts and a labelled search', async () => {
    const wrapper = await mountList()
    const filters = wrapper.findAll('[data-testid="edition-sync-books-filter"]')
    expect(filters.map((f) => f.text())).toEqual(['All 1,248', 'Problems 3', 'Queued 12', 'Synced 1,229', 'Off 4'])
    expect(filters[0]!.attributes('aria-pressed')).toBe('true')
    const search = wrapper.get('[data-testid="edition-sync-books-search"]')
    expect(wrapper.get(`label[for="${search.attributes('id')}"]`).text()).toBe('Search books')
  })

  it('words each row with the Editions card status and links the title to the book', async () => {
    const wrapper = await mountList()
    expect(row(wrapper, 0).text()).toContain("Couldn't index")
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-detail"]').text()).toBe('No audio stream found in chapter 12')
    expect(row(wrapper, 1).get('[data-testid="edition-sync-books-status"]').text()).toBe('Queued')
    expect(row(wrapper, 2).get('[data-testid="edition-sync-books-status"]').text()).toMatch(/· 42\s?%$/)
    expect(row(wrapper, 3).get('[data-testid="edition-sync-books-status"]').text()).toBe('Synced')
    expect(row(wrapper, 3).get('[data-testid="edition-sync-books-detail"]').text()).toMatch(/^Indexed /)
    expect(row(wrapper, 4).get('[data-testid="edition-sync-books-status"]').text()).toBe('Off')
    expect(row(wrapper, 4).get('[data-testid="edition-sync-books-detail"]').text()).toBe('Turned off for this book')
    expect(row(wrapper, 0).text()).toContain('M4B · EPUB')
    expect(JSON.parse(row(wrapper, 0).get('a').attributes('data-to')!)).toEqual({ name: 'book-detail', params: { bookId: 1 } })
    expect(row(wrapper, 0).get('img').attributes('src')).toContain('/api/v1/books/1/thumbnail')
  })

  it('retries and runs from the row button, and updates the row', async () => {
    const wrapper = await mountList()
    // The re-fetch after each action stays in flight, so the row shows the state the action answered with.
    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.retry.mockResolvedValue(editionSyncState({ status: 'running', stage: 'aligning', progress: 1 }, { bookId: 1 }))
    const retry = row(wrapper, 0).get('[data-testid="edition-sync-books-action"]')
    expect(retry.attributes('aria-label')).toBe('Retry indexing')
    await retry.trigger('click')
    await flushPromises()
    expect(mocks.retry).toHaveBeenCalledWith(1)
    expect(row(wrapper, 0).find('[data-testid="edition-sync-books-action"]').exists()).toBe(false)
    expect(mocks.fetchBooks).toHaveBeenCalledWith({ filter: 'all', q: undefined, page: 1 })

    mocks.run.mockResolvedValue(editionSyncState({ status: 'running' }, { bookId: 2 }))
    await row(wrapper, 1).get('[data-action="run"]').trigger('click')
    expect(mocks.run).toHaveBeenCalledWith(2)
    expect(row(wrapper, 3).find('[data-testid="edition-sync-books-action"]').exists()).toBe(false)
  })

  it('toggles a book', async () => {
    const wrapper = await mountList()
    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.update.mockResolvedValue(editionSyncState({ status: 'queued' }, { bookId: 5, syncEnabled: true }))
    await row(wrapper, 4).get('[data-testid="edition-sync-books-toggle"]').trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith(5, { syncEnabled: true })
    expect(row(wrapper, 4).get('[data-testid="edition-sync-books-status"]').text()).toBe('Queued')
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
  })

  it('re-fetches the page after a toggle so the counts and filter membership follow', async () => {
    const wrapper = await mountList()
    await wrapper.get('[data-filter="off"]').trigger('click')
    await flushPromises()
    mocks.fetchBooks.mockResolvedValue(response({ items: ITEMS.slice(0, 4), counts: { all: 1248, problems: 3, queued: 13, synced: 1229, off: 3 } }))
    mocks.update.mockResolvedValue(editionSyncState({ status: 'queued' }, { bookId: 5, syncEnabled: true }))
    await row(wrapper, 4).get('[data-testid="edition-sync-books-toggle"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'off', q: undefined, page: 1 })
    expect(wrapper.findAll('[data-testid="edition-sync-books-row"]')).toHaveLength(4)
    expect(wrapper.get('[data-filter="off"]').text()).toContain('3')
  })

  it('caps the search input and describes each switch by its status', async () => {
    const wrapper = await mountList()
    expect(wrapper.get('[data-testid="edition-sync-books-search"]').attributes('maxlength')).toBe('200')
    const status = row(wrapper, 0).get('[data-testid="edition-sync-books-status"]')
    expect(status.attributes('id')).toBeTruthy()
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-toggle"]').attributes('aria-describedby')).toBe(status.attributes('id'))
  })

  it('pages with Previous and Next and shows the range', async () => {
    const wrapper = await mountList()
    expect(wrapper.get('[data-testid="edition-sync-books-range"]').text()).toBe('1-5 of 1,248')
    expect(wrapper.get('[data-testid="edition-sync-books-previous"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="edition-sync-books-next"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'all', q: undefined, page: 2 })
  })

  it('switches filter on click', async () => {
    const wrapper = await mountList()
    await wrapper.get('[data-filter="problems"]').trigger('click')
    await flushPromises()
    expect(mocks.fetchBooks).toHaveBeenLastCalledWith({ filter: 'problems', q: undefined, page: 1 })
    expect(wrapper.get('[data-filter="problems"]').attributes('aria-pressed')).toBe('true')
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
    expect(wrapper.find('[data-testid="edition-sync-books-action"]').exists()).toBe(false)
    const toggle = (index: number) => row(wrapper, index).get('[data-testid="edition-sync-books-toggle"]')
    expect(toggle(0).attributes('disabled')).toBeUndefined()
    expect(toggle(0).attributes('aria-checked')).toBe('true')
    expect(toggle(1).attributes('aria-checked')).toBe('false')

    mocks.fetchBooks.mockClear().mockReturnValue(new Promise(() => {}))
    mocks.update.mockResolvedValue(
      editionSyncState({ status: 'none' }, { bookId: 2, syncEnabled: false, syncOverride: null, effectiveReason: 'user_disabled' }),
    )
    await toggle(1).trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith(2, { syncEnabled: true })
    expect(toggle(1).attributes('aria-checked')).toBe('true')
    expect(row(wrapper, 1).get('[data-testid="edition-sync-books-status"]').text()).toBe('Off')
    expect(mocks.fetchBooks).toHaveBeenCalledTimes(1)
    useEditionSyncSettings().settings.value = null
  })

  it('locks the toggles while edition sync is off for the server', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ disabledReason: 'server_disabled' }))
    const wrapper = await mountList()
    expect(row(wrapper, 0).get('[data-testid="edition-sync-books-toggle"]').attributes('disabled')).toBeDefined()
  })

  it('says when nothing matches', async () => {
    mocks.fetchBooks.mockResolvedValue(response({ items: [], total: 0 }))
    const wrapper = await mountList()
    expect(wrapper.get('[data-testid="edition-sync-books-empty"]').text()).toBe('No books match.')
    expect(wrapper.find('[data-testid="edition-sync-books-range"]').exists()).toBe(false)
  })
})
