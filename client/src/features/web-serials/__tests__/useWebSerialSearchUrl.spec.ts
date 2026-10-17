import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import type { discoverSerials, searchSerials, resolveSerialUrl, fetchSeries, fetchSeriesLookup } from '../api/webSerials'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { catalogEntry, hit } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<typeof discoverSerials>(),
  searchSerials: vi.fn<typeof searchSerials>(),
  resolveSerialUrl: vi.fn<typeof resolveSerialUrl>(),
  fetchSeries: vi.fn<typeof fetchSeries>(),
  fetchSeriesLookup: vi.fn<typeof fetchSeriesLookup>(),
}))
const router = vi.hoisted(() => ({ replace: vi.fn<(to: unknown) => Promise<void>>(), push: vi.fn<(to: unknown) => Promise<void>>() }))
const route = reactive<{ name: string; query: Record<string, string> }>({ name: 'web-serials', query: {} })

vi.mock('../api/webSerials', () => api)
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))

import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'
import { clearStoredSearch, resetStoredSearchMemory, saveStoredSearch, type StoredWebSerialSearch } from '../composables/webSerialSearchStore'

enableAutoUnmount(afterEach)

const KEY = 'bookorbit.webSerials.lastSearch'
const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

function lastReplace(): { name: string; query: Record<string, string> } {
  const calls = router.replace.mock.calls
  return calls[calls.length - 1]![0] as { name: string; query: Record<string, string> }
}

async function mountPanel(props: { userId?: number | null } = {}) {
  const wrapper = mount(WebSerialsSearchPanel, { props, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearStoredSearch()
  route.name = 'web-serials'
  route.query = {}
  router.replace.mockResolvedValue(undefined)
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
  api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
  api.searchSerials.mockResolvedValue({
    query: 'one piece',
    hits: [hit({ sourceName: 'AllManga' }), hit({ sourceName: 'Other', url: 'https://x/2' })],
    failedSources: [],
  })
})

describe('web serials search in the URL', () => {
  it('writes the search with replace, only when it is run, and keeps the tab param', async () => {
    route.query = { tab: 'queue' }
    const wrapper = await mountPanel()
    await wrapper.get('#web-serials-query').setValue('one piece')
    expect(router.replace).not.toHaveBeenCalled()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(lastReplace()).toEqual({ name: 'web-serials', query: { tab: 'queue', q: 'one piece', kind: 'all' } })
    expect(router.push).not.toHaveBeenCalled()
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toMatchObject({ q: 'one piece', kind: 'all', mode: 'series' })
  })

  it('updates the URL when the scope changes', async () => {
    const wrapper = await mountPanel()
    await wrapper.get('#web-serials-query').setValue('one piece')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const manga = wrapper
      .findAll('fieldset button')
      .find((button) => button.attributes('aria-pressed') !== undefined && button.text().toLowerCase().includes('manga'))!
    await manga.trigger('click')
    await flushPromises()
    expect(lastReplace().query).toMatchObject({ q: 'one piece', kind: 'manga' })
    expect(api.discoverSerials).toHaveBeenLastCalledWith('one piece', 'manga', expect.anything(), false)
    expect(JSON.parse(window.sessionStorage.getItem('bookorbit.webSerials.lastResults')!)).toMatchObject({ q: 'one piece', kind: 'manga' })
  })

  it('commits the text that was searched, not what was typed while it ran', async () => {
    let answer: (value: Awaited<ReturnType<typeof discoverSerials>>) => void = () => undefined
    api.discoverSerials.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const wrapper = await mountPanel()
    await wrapper.get('#web-serials-query').setValue('one piece')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('#web-serials-query').setValue('bleach')
    answer({ results: [catalogEntry()], fallback: null })
    await flushPromises()

    expect(lastReplace().query).toMatchObject({ q: 'one piece' })
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toMatchObject({ q: 'one piece' })
  })

  it('runs the search on mount from the URL and restores mode and source', async () => {
    route.query = { q: 'one piece', kind: 'manga', mode: 'sites', source: 'AllManga' }
    await mountPanel()
    expect(api.discoverSerials).not.toHaveBeenCalled()
    expect(api.searchSerials).toHaveBeenCalledWith('one piece', 'manga', expect.anything(), false)
    expect(lastReplace().query).toMatchObject({ q: 'one piece', kind: 'manga', mode: 'sites', source: 'AllManga' })
  })

  it('runs a series search from the URL and does not open a preview', async () => {
    route.query = { q: 'one piece' }
    const wrapper = await mountPanel()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('preview-loading')).toBeUndefined()
    expect(wrapper.emitted('open-entry')).toBeUndefined()
  })

  it('restores the last search from sessionStorage when the URL has no q', async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ q: 'frieren', kind: 'novel', mode: 'series', source: null }))
    route.query = { other: 'keep' }
    await mountPanel()
    expect(router.replace).toHaveBeenCalledWith({ name: 'web-serials', query: { other: 'keep', q: 'frieren', kind: 'novel' } })
    expect(api.discoverSerials).toHaveBeenCalledWith('frieren', 'novel', expect.anything(), false)
  })

  it('does not restore onto the queue tab', async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ q: 'frieren', kind: 'all', mode: 'series', source: null }))
    route.query = { tab: 'queue' }
    await mountPanel()
    expect(api.discoverSerials).not.toHaveBeenCalled()
  })

  it('clearing the search box removes it from the URL and storage', async () => {
    route.query = { q: 'one piece', kind: 'all', tab: 'queue' }
    const wrapper = await mountPanel()
    await wrapper.get('#web-serials-query').setValue('')
    expect(lastReplace()).toEqual({ name: 'web-serials', query: { tab: 'queue' } })
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it('keeps working when sessionStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const wrapper = await mountPanel()
    await wrapper.get('#web-serials-query').setValue('one piece')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(lastReplace().query).toMatchObject({ q: 'one piece' })
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    get.mockRestore()
    set.mockRestore()
  })
})

const RESULTS_KEY = 'bookorbit.webSerials.lastResults'

function stored(overrides: Partial<StoredWebSerialSearch> = {}): StoredWebSerialSearch {
  return {
    q: 'one piece',
    kind: 'all',
    mode: 'series',
    source: null,
    showMachineTranslations: false,
    entries: [catalogEntry({ title: 'One Piece' })],
    entriesQuery: 'one piece',
    mangaHits: [],
    novelHits: [],
    failedSources: [],
    novelSourcesDisabled: false,
    fallbackReason: null,
    fetchedAt: Date.now() - 5 * 60_000,
    ...overrides,
  }
}

async function searchFor(wrapper: Awaited<ReturnType<typeof mountPanel>>, text: string) {
  await wrapper.get('#web-serials-query').setValue(text)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

function refreshButton(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  return wrapper.get('[data-testid="results-age"] button')
}

describe('kept search results', () => {
  it('does not hand the search of one user to the next user of the tab', async () => {
    const first = await mountPanel({ userId: 7 })
    await searchFor(first, 'one piece')
    first.unmount()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)

    route.query = {}
    const second = await mountPanel({ userId: 8 })

    expect(window.sessionStorage.getItem(KEY)).toBeNull()
    expect(window.sessionStorage.getItem(RESULTS_KEY)).toBeNull()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect((second.get('#web-serials-query').element as HTMLInputElement).value).toBe('')

    second.unmount()
    route.query = { q: 'one piece', kind: 'all' }
    await mountPanel({ userId: 8 })
    expect(api.discoverSerials).toHaveBeenCalledTimes(2)
  })

  it('keeps the search for the same user', async () => {
    const first = await mountPanel({ userId: 7 })
    await searchFor(first, 'one piece')
    first.unmount()

    route.query = { q: 'one piece', kind: 'all' }
    await mountPanel({ userId: 7 })
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
  })

  it('shows the last results instantly when coming back to the page, with no request', async () => {
    const first = await mountPanel()
    await searchFor(first, 'one piece')
    first.unmount()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)

    route.query = { q: 'one piece', kind: 'all' }
    const second = await mountPanel()

    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect(second.find('[data-testid="series-results"]').exists()).toBe(true)
    expect(second.get('[data-testid="results-age"]').text()).toContain('Results from')
  })

  it('shows them after a refresh from sessionStorage', async () => {
    const first = await mountPanel()
    await searchFor(first, 'one piece')
    first.unmount()
    expect(window.sessionStorage.getItem(RESULTS_KEY)).toContain('one piece')
    resetStoredSearchMemory()
    api.discoverSerials.mockClear()

    route.query = { q: 'one piece', kind: 'all' }
    const second = await mountPanel()

    expect(api.discoverSerials).not.toHaveBeenCalled()
    expect(second.find('[data-testid="series-results"]').exists()).toBe(true)
  })

  it('restores sites results, the source filter and the failed sources', async () => {
    saveStoredSearch(
      stored({
        mode: 'sites',
        entries: [],
        mangaHits: [hit({ sourceName: 'AllManga' }), hit({ sourceName: 'Other', url: 'https://x/2' })],
        failedSources: ['Slow'],
        fallbackReason: 'empty',
      }),
    )
    route.query = { q: 'one piece', kind: 'all', mode: 'sites', source: 'Other' }
    const wrapper = await mountPanel()

    expect(api.searchSerials).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Other')
    expect(wrapper.text()).toContain('Retry failed sources')
    expect(lastReplace().query).toMatchObject({ q: 'one piece', mode: 'sites', source: 'Other' })
  })

  it('shows stale results at once and swaps them when the background search answers', async () => {
    saveStoredSearch(stored({ fetchedAt: Date.now() - 31 * 60_000 }))
    let answer: (value: Awaited<ReturnType<typeof discoverSerials>>) => void = () => undefined
    api.discoverSerials.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    route.query = { q: 'one piece', kind: 'all' }

    const wrapper = await mountPanel()

    expect(api.discoverSerials).toHaveBeenCalledWith('one piece', 'all', expect.anything(), false)
    expect(wrapper.text()).toContain('One Piece')
    expect(wrapper.find('[data-testid="pending-series"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="results-age"]').text()).toContain('Refreshing')

    answer({ results: [catalogEntry({ title: 'One Piece Remastered' })], fallback: null })
    await flushPromises()

    expect(wrapper.text()).toContain('One Piece Remastered')
    expect(wrapper.get('[data-testid="results-age"]').text()).toContain('just now')
  })

  it('keeps the old results when the background search fails', async () => {
    saveStoredSearch(stored({ fetchedAt: Date.now() - 31 * 60_000 }))
    api.discoverSerials.mockRejectedValue(new Error('down'))
    route.query = { q: 'one piece', kind: 'all' }

    const wrapper = await mountPanel()

    expect(wrapper.text()).toContain('One Piece')
    expect(wrapper.text()).toContain('Could not refresh')
  })

  it('does not search again for fresh results', async () => {
    saveStoredSearch(stored())
    route.query = { q: 'one piece', kind: 'all' }
    await mountPanel()
    expect(api.discoverSerials).not.toHaveBeenCalled()
  })

  it('forces a fresh server answer with the Refresh button', async () => {
    saveStoredSearch(stored())
    route.query = { q: 'one piece', kind: 'all' }
    const wrapper = await mountPanel()

    await refreshButton(wrapper).trigger('click')
    await flushPromises()

    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect(api.discoverSerials).toHaveBeenCalledWith('one piece', 'all', expect.anything(), true)
  })

  it('retries the failed sites with the same cache bypass', async () => {
    saveStoredSearch(stored({ mode: 'sites', entries: [], mangaHits: [hit()], failedSources: ['Slow'] }))
    route.query = { q: 'one piece', kind: 'all', mode: 'sites' }
    const wrapper = await mountPanel()

    const retry = wrapper.findAll('button').find((button) => button.text() === 'Retry failed sources')!
    await retry.trigger('click')
    await flushPromises()

    expect(api.searchSerials).toHaveBeenCalledWith('one piece', 'manga', expect.anything(), true)
    expect(api.searchSerials).toHaveBeenCalledWith('one piece', 'novel', expect.anything(), true)
  })

  it('replaces the kept results when a new search is run', async () => {
    const wrapper = await mountPanel()
    await searchFor(wrapper, 'one piece')
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry({ title: 'Bleach' })], fallback: null })
    await searchFor(wrapper, 'bleach')

    const saved = JSON.parse(window.sessionStorage.getItem(RESULTS_KEY)!)
    expect(saved.q).toBe('bleach')
    expect(saved.entries[0].title).toBe('Bleach')
  })

  it('drops the kept results when the URL asks for a different search', async () => {
    saveStoredSearch(stored())
    route.query = { q: 'bleach', kind: 'all' }
    await mountPanel()

    expect(api.discoverSerials).toHaveBeenCalledWith('bleach', 'all', expect.anything(), false)
    expect(JSON.parse(window.sessionStorage.getItem(RESULTS_KEY)!).q).toBe('bleach')
  })

  it('clears the kept results when the search box is emptied', async () => {
    saveStoredSearch(stored())
    route.query = { q: 'one piece', kind: 'all' }
    const wrapper = await mountPanel()

    await wrapper.get('#web-serials-query').setValue('')

    expect(window.sessionStorage.getItem(RESULTS_KEY)).toBeNull()
    resetStoredSearchMemory()
    route.query = { q: 'one piece', kind: 'all' }
    await mountPanel()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
  })

  it('ignores unreadable stored results and searches normally', async () => {
    window.sessionStorage.setItem(RESULTS_KEY, '{not json')
    resetStoredSearchMemory()
    route.query = { q: 'one piece', kind: 'all' }
    await mountPanel()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
  })

  it('still shows results within the visit when sessionStorage rejects writes', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const first = await mountPanel()
    await searchFor(first, 'one piece')
    first.unmount()

    route.query = { q: 'one piece', kind: 'all' }
    const second = await mountPanel()

    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect(second.find('[data-testid="series-results"]').exists()).toBe(true)
    set.mockRestore()
  })

  it('keeps at most 200 rows per list in storage', async () => {
    saveStoredSearch(stored({ entries: Array.from({ length: 250 }, (_, index) => catalogEntry({ matchId: String(index) })) }))
    expect(JSON.parse(window.sessionStorage.getItem(RESULTS_KEY)!).entries).toHaveLength(200)
  })
})

describe('web serials not set up', () => {
  const NONE: WebSerialCapabilities = {
    manga: { available: false, searchable: false, defaultLibraryId: null, targetFolderId: null },
    novel: { available: false, searchable: false, acceptsLinks: false, defaultLibraryId: null, targetFolderId: null },
  }

  async function mountNotReady(canSetUp: boolean) {
    api.fetchCapabilities.mockResolvedValue(NONE)
    const wrapper = mount(WebSerialsSearchPanel, { props: { canSetUp }, global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    return wrapper
  }

  it('links an admin to the setup page', async () => {
    const wrapper = await mountNotReady(true)
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'settings-admin-web-serials' })
    expect(wrapper.text()).not.toContain('Ask an administrator')
  })

  it('tells everyone else to ask an administrator', async () => {
    const wrapper = await mountNotReady(false)
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false)
    expect(wrapper.text()).toContain('Ask an administrator')
  })
})

it('restores changed q and kind on a mounted panel without replaying its own writes', async () => {
  route.query = { q: 'one piece', kind: 'manga' }
  await mountPanel()
  api.discoverSerials.mockClear()
  route.query = { q: 'new novel', kind: 'novel' }
  await flushPromises()
  expect(api.discoverSerials).toHaveBeenCalledExactlyOnceWith('new novel', 'novel', expect.anything(), false)
  route.query = lastReplace().query
  await flushPromises()
  expect(api.discoverSerials).toHaveBeenCalledTimes(1)
  route.query = { q: 'new novel', kind: 'manga' }
  await flushPromises()
  expect(api.discoverSerials).toHaveBeenCalledTimes(2)
})

it('clears on Back removing q without writing the old search back', async () => {
  route.query = { q: 'one piece', kind: 'manga' }
  const wrapper = await mountPanel()
  router.replace.mockClear()
  route.query = {}
  await flushPromises()
  expect(router.replace).not.toHaveBeenCalled()
  expect((wrapper.get('#web-serials-query').element as HTMLInputElement).value).toBe('')
  expect(sessionStorage.getItem(KEY)).toBeNull()
})
it('does not commit an old submit over a newer URL search', async () => {
  let finish!: (value: Awaited<ReturnType<typeof discoverSerials>>) => void
  api.discoverSerials.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const wrapper = await mountPanel()
  await wrapper.get('#web-serials-query').setValue('old title')
  await wrapper.get('form').trigger('submit')
  route.query = { q: 'new title', kind: 'manga' }
  await flushPromises()
  finish({ results: [catalogEntry()], fallback: null })
  await flushPromises()
  expect(lastReplace().query.q).toBe('new title')
})
it('does not restore twice while the mount restore awaits capabilities', async () => {
  let finish!: (value: WebSerialCapabilities) => void
  api.fetchCapabilities.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  route.query = { q: 'one piece', kind: 'manga' }
  await mountPanel()
  route.query = { q: 'one piece', kind: 'manga' }
  await flushPromises()
  finish(BOTH)
  await flushPromises()
  expect(api.discoverSerials).toHaveBeenCalledTimes(1)
})
it('shares a restore in flight instead of submitting twice', async () => {
  const { effectScope, ref } = await import('vue')
  const { useWebSerialSearch } = await import('../composables/useWebSerialSearch')
  const { useWebSerialSearchUrl } = await import('../composables/useWebSerialSearchUrl')
  route.query = { q: 'one piece', kind: 'manga' }
  const scope = effectScope()
  let finish!: () => void
  const search = scope.run(() => useWebSerialSearch())!
  const submit = vi.spyOn(search, 'submit').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null)
      }),
  )
  const url = scope.run(() => useWebSerialSearchUrl(search, ref(null)))!
  const first = url.restore()
  await flushPromises()
  const second = url.restore()
  await flushPromises()
  expect(submit).toHaveBeenCalledTimes(1)
  finish()
  await Promise.all([first, second])
  scope.stop()
})
