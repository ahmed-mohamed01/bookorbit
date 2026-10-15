import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialCapabilities, WebSerialSourceOptions } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { catalogEntry, hit, mangaDetail } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchSeriesLookup: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchSeriesSources: vi.fn<(key: string) => Promise<unknown>>(),
  fetchDiscoverSources: vi.fn<(...args: unknown[]) => Promise<WebSerialSourceOptions>>(),
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn<() => Promise<void>>() }),
}))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  const libraries = ref([{ id: 1, type: 'books', name: 'Manga', accessLevel: 'owner', folders: [{ id: 11, path: '/manga' }] }])
  return { useLibraries: () => ({ libraries, loaded: ref(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

import WebSerialPreviewSheet from '../components/WebSerialPreviewSheet.vue'
import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const sheetStubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

const option = (seriesKey: string, sourceName: string, chapterCount: number, mostComplete = false) => ({
  seriesKey,
  sourceName,
  title: 'Frieren',
  chapterCount,
  latestAt: null,
  confidence: 'same_series' as const,
  mostComplete,
})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
  api.searchSerials.mockResolvedValue({ query: 'frieren', hits: [hit({ title: 'Frieren (site result)' })], failedSources: [] })
})

async function search(wrapper: ReturnType<typeof mount>, text = 'frieren') {
  await wrapper.get('#web-serials-query').setValue(text)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

describe('WebSerialsSearchPanel series results', () => {
  it('renders one row per series with year, authors, status and an In library marker, and no source controls', async () => {
    api.discoverSerials.mockResolvedValue({
      results: [catalogEntry(), catalogEntry({ matchId: '2', title: 'Another Series', inLibrary: true, authors: [], year: null, status: 'unknown' })],
      fallback: null,
    })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await search(wrapper)

    const rows = wrapper.findAll('[data-testid="series-results"] li')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Frieren: Beyond Journey’s End')
    expect(rows[0]!.text()).toContain('Manga')
    expect(rows[0]!.text()).toContain('Kanehito Yamada')
    expect(rows[0]!.text()).toContain('2020')
    expect(rows[0]!.text()).toContain('Ongoing')
    expect(rows[0]!.text()).not.toContain('In library')
    expect(rows[1]!.text()).toContain('In library')
    expect(api.searchSerials).not.toHaveBeenCalled()
    const sortOptions = wrapper.findAll('[data-testid="result-controls"] option').map((option) => option.text())
    expect(sortOptions).toEqual(['Relevance', 'Title A to Z'])
    expect(wrapper.text()).not.toContain('Filter results by source')
  })

  it('opens the series when a row is chosen', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await search(wrapper)

    await wrapper.get('[data-testid="series-results"] button').trigger('click')

    expect(wrapper.emitted('open-entry')?.[0]?.[0]).toMatchObject({ matchId: '1995' })
  })

  it('has a compact row density', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await search(wrapper)

    await wrapper.get('button[aria-label="Compact"]').trigger('click')

    expect(wrapper.get('[data-testid="series-results"] button').attributes('data-density')).toBe('compact')
  })

  it('searches the sites directly from the link under the list and comes back with the link above the results', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await search(wrapper)

    const direct = wrapper.findAll('button').find((button) => button.text() === 'Search the sites directly')!
    await direct.trigger('click')
    await flushPromises()

    expect(api.searchSerials).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Frieren (site result)')
    expect(wrapper.find('[data-testid="series-results"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fallback-notice"]').exists()).toBe(false)

    const back = wrapper.findAll('button').find((button) => button.text() === 'Back to series results')!
    await back.trigger('click')

    expect(wrapper.find('[data-testid="series-results"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Frieren (site result)')
  })

  it.each([
    ['disabled', 'Showing results from your sources because the series database is turned off.'],
    ['unavailable', 'Showing results from your sources because the series database is unavailable.'],
    ['empty', 'Showing results from your sources because the series database has nothing for this search.'],
  ] as const)('falls back to source results with one muted line when the database is "%s"', async (reason, message) => {
    api.discoverSerials.mockResolvedValue({ results: [], fallback: reason })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await search(wrapper)

    expect(wrapper.get('[data-testid="fallback-notice"]').text()).toBe(message)
    expect(wrapper.text()).toContain('Frieren (site result)')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Back to series results')).toBe(false)
  })

  it('falls back with the unavailable line when the series request itself fails', async () => {
    api.discoverSerials.mockRejectedValue(new Error('500'))
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await search(wrapper)

    expect(wrapper.get('[data-testid="fallback-notice"]').text()).toContain('the series database is unavailable')
    expect(wrapper.text()).toContain('Frieren (site result)')
  })

  it('searches the sites with the title from the preview', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await search(wrapper)

    ;(wrapper.vm as unknown as { searchSitesFor: (title: string) => void }).searchSitesFor('Frieren: Beyond Journey’s End')
    await flushPromises()

    expect(api.searchSerials).toHaveBeenCalledWith('Frieren: Beyond Journey’s End', expect.any(String), expect.any(AbortSignal), false)
  })
})

function mountEntrySheet(entry = catalogEntry()) {
  return mount(WebSerialPreviewSheet, { props: { detail: null, entry, open: true }, global: { plugins: [i18n], stubs: sheetStubs } })
}

describe('WebSerialPreviewSheet opened from a series result', () => {
  it('shows the database details at once and a finding state while the sources are searched', async () => {
    api.fetchDiscoverSources.mockReturnValue(new Promise(() => undefined))

    const wrapper = mountEntrySheet()
    await flushPromises()

    expect(wrapper.get('h2').text()).toBe('Frieren: Beyond Journey’s End')
    expect(wrapper.text()).toContain('An elf outlives her party.')
    expect(wrapper.text()).toContain('Kanehito Yamada')
    expect(wrapper.text()).toContain('Fantasy')
    expect(wrapper.get('[data-testid="sources-finding"]').text()).toContain('Finding it on your sources...')
    const get = wrapper.findAll('button').find((button) => button.text() === 'Get')!
    expect(get.attributes('disabled')).toBeDefined()
  })

  it('preselects the most complete source and loads its chapters with the match id', async () => {
    api.fetchDiscoverSources.mockResolvedValue({
      options: [option('m:9', 'Big Site', 300, true), option('m:2', 'Small Site', 20)],
      failedSources: [],
    })
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9', sourceName: 'Big Site', title: 'Frieren' }))

    const wrapper = mountEntrySheet()
    await flushPromises()

    expect(api.fetchSeries).toHaveBeenCalledWith('m:9', '1995', expect.any(AbortSignal))
    const radios = wrapper.findAll('input[name="web-serials-source"]')
    expect(radios).toHaveLength(2)
    expect((radios[0]!.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('Most complete')
    expect(wrapper.text()).toContain('Big Site')
    expect(wrapper.get('h2').text()).toBe('Frieren: Beyond Journey’s End')
    expect(api.fetchSeriesLookup).toHaveBeenCalledWith('m:9', '1995')
    const get = wrapper.findAll('button').find((button) => button.text() === 'Get')!
    expect(get.attributes('disabled')).toBeUndefined()
  })

  it('sends the preset match id with the job', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [option('m:9', 'Big Site', 300, true)], failedSources: [] })
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))
    api.createSerialJob.mockResolvedValue({ id: 5 })
    const wrapper = mountEntrySheet()
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Get')!
      .trigger('click')
    await flushPromises()

    expect(api.createSerialJob).toHaveBeenCalledWith(
      expect.objectContaining({ seriesKey: 'm:9', metadata: expect.objectContaining({ matchId: '1995' }) }),
    )
  })

  it('switches to another source and keeps the match id', async () => {
    api.fetchDiscoverSources.mockResolvedValue({
      options: [option('m:9', 'Big Site', 300, true), option('m:2', 'Small Site', 20)],
      failedSources: [],
    })
    api.fetchSeries.mockImplementation(async (key: unknown) =>
      mangaDetail({ seriesKey: key as string, sourceName: key === 'm:2' ? 'Small Site' : 'Big Site' }),
    )
    const wrapper = mountEntrySheet()
    await flushPromises()

    await wrapper.findAll('input[name="web-serials-source"]')[1]!.setValue(true)
    await flushPromises()

    expect(api.fetchSeries).toHaveBeenLastCalledWith('m:2', '1995', expect.any(AbortSignal))
  })

  it('checks the sources again when the same series is reopened after nothing was found', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: ['Slow Site'] })
    const wrapper = mountEntrySheet()
    await flushPromises()
    expect(api.fetchDiscoverSources).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()

    expect(api.fetchDiscoverSources).toHaveBeenCalledTimes(2)
  })

  it('says it is not available from the sources, notes failed ones, disables Get and offers the direct search', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: ['Slow Site'] })

    const wrapper = mountEntrySheet()
    await flushPromises()

    const none = wrapper.get('[data-testid="sources-none"]')
    expect(none.text()).toContain('Not available from your sources')
    expect(none.text()).toContain('1 source could not be checked.')
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === 'Get')!
        .attributes('disabled'),
    ).toBeDefined()

    await none
      .findAll('button')
      .find((button) => button.text() === 'Search the sites directly')!
      .trigger('click')

    expect(wrapper.emitted('search-sites')?.[0]).toEqual(['Frieren: Beyond Journey’s End'])
  })

  it('shows a retryable error when the source check fails', async () => {
    api.fetchDiscoverSources.mockRejectedValueOnce(new Error('Could not look for this series on your sources.'))
    const wrapper = mountEntrySheet()
    await flushPromises()
    expect(wrapper.get('[data-testid="sources-error"]').text()).toContain('Could not look for this series on your sources.')

    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: [] })
    await wrapper
      .get('[data-testid="sources-error"]')
      .findAll('button')
      .find((button) => button.text() === 'Retry')!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="sources-none"]').exists()).toBe(true)
  })
})
