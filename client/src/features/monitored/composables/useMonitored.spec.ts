import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { MONITORED_IDLE_TRIM_MS, useMonitored } from './useMonitored'

type PageRequest = { page: number; size: number }
type PageResponse = { items: { id: string }[]; total: number; page: number; size: number }

const api = vi.hoisted(() => ({
  fetchMonitoredAuthors: vi.fn<(request: PageRequest) => Promise<PageResponse>>(),
  fetchMonitoredBooks: vi.fn<(request: PageRequest) => Promise<PageResponse>>(),
  fetchMonitoredReleases: vi.fn<(request: PageRequest) => Promise<PageResponse>>(),
  fetchMonitoredSummary: vi.fn<() => Promise<{ authors: number; books: number; releases: number }>>(),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../api/monitored', () => api)

describe('useMonitored', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends zero-based author pages and stops when the envelope total is loaded', async () => {
    // hasMore compares page * PAGE_SIZE (50) against the envelope total, so the total has to exceed
    // one page's worth for a second request to fire, even though each mocked page returns one item.
    api.fetchMonitoredAuthors
      .mockResolvedValueOnce({ items: [{ id: 'a' }], total: 60, page: 0, size: 50 })
      .mockResolvedValueOnce({ items: [{ id: 'b' }], total: 60, page: 1, size: 50 })
    const monitored = useMonitored()
    const options = { sort: 'name' as const, order: 'asc' as const }

    await monitored.loadAuthors(options, true)
    await monitored.loadAuthors(options)
    await monitored.loadAuthors(options)

    expect(monitored.authors.value.map((item) => item.id)).toEqual(['a', 'b'])
    expect(monitored.authorTotal.value).toBe(60)
    expect(api.fetchMonitoredAuthors.mock.calls.map(([request]) => request.page)).toEqual([0, 1])
  })

  it('sends search, sort, order, and time filter to the releases endpoint', async () => {
    api.fetchMonitoredReleases.mockResolvedValue({ items: [], total: 0, page: 0, size: 50 })
    const monitored = useMonitored()

    await monitored.loadReleases({ q: 'orbit', sort: 'author', order: 'desc', filter: 'soon' }, true)

    expect(api.fetchMonitoredReleases).toHaveBeenCalledWith({ q: 'orbit', sort: 'author', order: 'desc', filter: 'soon', page: 0, size: 50 })
  })

  it('caps retained authors at 1500 and drops whole front pages once an append would exceed it', async () => {
    const PAGE_SIZE = 50
    const PAGE_COUNT = 31
    const total = PAGE_COUNT * PAGE_SIZE
    for (let page = 0; page < PAGE_COUNT; page++) {
      api.fetchMonitoredAuthors.mockResolvedValueOnce({
        items: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `p${page}-${i}` })),
        total,
        page,
        size: PAGE_SIZE,
      })
    }
    const monitored = useMonitored()
    const options = { sort: 'name' as const, order: 'asc' as const }

    for (let page = 0; page < PAGE_COUNT; page++) {
      await monitored.loadAuthors(options, page === 0)
    }

    // 31 pages of 50 = 1550 > the 1500 cap, so the oldest page (page 0) is dropped whole.
    expect(monitored.authors.value).toHaveLength(1500)
    expect(monitored.authors.value[0]?.id).toBe('p1-0')
    expect(monitored.authorDroppedOffset.value).toBe(PAGE_SIZE)
  })

  it('resets the dropped offset when a fresh reset load replaces the list', async () => {
    api.fetchMonitoredBooks
      .mockResolvedValueOnce({ items: [{ id: 'b1' }], total: 100, page: 0, size: 50 })
      .mockResolvedValueOnce({ items: [{ id: 'b2' }], total: 100, page: 1, size: 50 })
    const monitored = useMonitored()
    const options = { sort: 'added' as const, order: 'desc' as const }
    await monitored.loadBooks(options, true)
    await monitored.loadBooks(options)
    expect(monitored.books.value.map((item) => item.id)).toEqual(['b1', 'b2'])

    api.fetchMonitoredBooks.mockResolvedValueOnce({ items: [{ id: 'fresh' }], total: 1, page: 0, size: 50 })
    await monitored.loadBooks(options, true)

    expect(monitored.books.value.map((item) => item.id)).toEqual(['fresh'])
    expect(monitored.bookDroppedOffset.value).toBe(0)
  })
})

describe('useMonitored idle retention while kept alive', () => {
  function mountKeptAlive() {
    let composable!: ReturnType<typeof useMonitored>
    const showSource = ref(true)
    const Source = defineComponent({
      setup() {
        composable = useMonitored()
        return {}
      },
      template: '<div />',
    })
    const Harness = defineComponent({
      components: { Source },
      setup() {
        return { showSource }
      },
      template: '<KeepAlive><Source v-if="showSource" /></KeepAlive>',
    })
    const wrapper = mount(Harness)
    return { composable, wrapper, showSource }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('trims every list to its first page after being deactivated past the idle window', async () => {
    api.fetchMonitoredAuthors
      .mockResolvedValueOnce({ items: [{ id: 'a1' }], total: 60, page: 0, size: 50 })
      .mockResolvedValueOnce({ items: [{ id: 'a2' }], total: 60, page: 1, size: 50 })
    const { composable, wrapper, showSource } = mountKeptAlive()
    const options = { sort: 'name' as const, order: 'asc' as const }
    await composable.loadAuthors(options, true)
    await composable.loadAuthors(options)
    expect(composable.authors.value.map((item) => item.id)).toEqual(['a1', 'a2'])

    showSource.value = false
    await nextTick()
    vi.advanceTimersByTime(MONITORED_IDLE_TRIM_MS)

    expect(composable.authors.value.map((item) => item.id)).toEqual(['a1'])
    expect(composable.idleTrimmed.value).toBe(true)
    expect(composable.authorDroppedOffset.value).toBe(0)
    wrapper.unmount()
  })

  it('does not trim before the idle window has fully elapsed', async () => {
    api.fetchMonitoredAuthors
      .mockResolvedValueOnce({ items: [{ id: 'a1' }], total: 60, page: 0, size: 50 })
      .mockResolvedValueOnce({ items: [{ id: 'a2' }], total: 60, page: 1, size: 50 })
    const { composable, wrapper, showSource } = mountKeptAlive()
    const options = { sort: 'name' as const, order: 'asc' as const }
    await composable.loadAuthors(options, true)
    await composable.loadAuthors(options)

    showSource.value = false
    await nextTick()
    vi.advanceTimersByTime(MONITORED_IDLE_TRIM_MS - 1)

    expect(composable.authors.value.map((item) => item.id)).toEqual(['a1', 'a2'])
    expect(composable.idleTrimmed.value).toBe(false)
    wrapper.unmount()
  })

  it('keeps the full list and cancels the pending trim when reactivated within the idle window', async () => {
    api.fetchMonitoredAuthors
      .mockResolvedValueOnce({ items: [{ id: 'a1' }], total: 60, page: 0, size: 50 })
      .mockResolvedValueOnce({ items: [{ id: 'a2' }], total: 60, page: 1, size: 50 })
    const { composable, wrapper, showSource } = mountKeptAlive()
    const options = { sort: 'name' as const, order: 'asc' as const }
    await composable.loadAuthors(options, true)
    await composable.loadAuthors(options)

    showSource.value = false
    await nextTick()
    vi.advanceTimersByTime(MONITORED_IDLE_TRIM_MS - 1000)
    showSource.value = true
    await nextTick()
    // Past when the original (cancelled) timer would have fired, to prove it never ran.
    vi.advanceTimersByTime(2000)

    expect(composable.authors.value.map((item) => item.id)).toEqual(['a1', 'a2'])
    expect(composable.idleTrimmed.value).toBe(false)
    wrapper.unmount()
  })
})
