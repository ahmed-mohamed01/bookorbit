import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialCapabilities, WebSerialPackaging } from '@bookorbit/types'
import { hit, job, mangaDetail, novelDetail, uiStubs, unit } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(key: string) => Promise<unknown>>(),
  fetchSeriesLookup: vi.fn<(key: string) => Promise<unknown>>(),
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeriesSources: vi.fn<(key: string) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn<() => Promise<void>>() }),
}))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  const libraries = ref([{ id: 1, type: 'books', name: 'Novels', accessLevel: 'owner', folders: [{ id: 11, path: '/novels' }] }])
  return { useLibraries: () => ({ libraries, loaded: ref(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

import WebSerialJobRow from '../components/WebSerialJobRow.vue'
import WebSerialPreviewSheet from '../components/WebSerialPreviewSheet.vue'
import WebSerialResultRow from '../components/WebSerialResultRow.vue'
import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const sheetStubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.discoverSerials.mockResolvedValue({ results: [], fallback: 'disabled' })
  api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
})

describe('WebSerialsSearchPanel', () => {
  it('switches the button to Open link when a link is pasted', async () => {
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    const input = wrapper.get('#web-serials-query')

    await input.setValue('Tower Climber')
    expect(wrapper.get('button[type="submit"]').text()).toBe('Search')

    await input.setValue('https://www.royalroad.com/fiction/1/x')
    expect(wrapper.get('button[type="submit"]').text()).toBe('Open link')
  })

  it('opens the preview for a pasted link instead of searching', async () => {
    api.resolveSerialUrl.mockResolvedValue(novelDetail())
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await wrapper.get('#web-serials-query').setValue('https://www.royalroad.com/fiction/1/x')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.searchSerials).not.toHaveBeenCalled()
    expect(wrapper.emitted('preview-loading')).toHaveLength(1)
    expect(wrapper.emitted('open')?.[0]?.[0]).toMatchObject({ seriesKey: 'n:3' })
  })

  it('says novels are link-only when novel search is unavailable', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
      novel: { available: true, searchable: false, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    expect(wrapper.get('#web-serials-query').attributes('placeholder')).toBe('Search manga by title, or paste a link')
    expect(wrapper.text()).toContain('Novels are added by link')
  })

  it('lists results and opens a hit when its row is clicked', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => ({
      query: 'tower',
      hits: kind === 'manga' ? [hit()] : [],
      failedSources: [],
    }))
    api.fetchSeries.mockResolvedValue(mangaDetail())
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Tower Climber')
    expect(wrapper.text()).toContain('42 chapters')

    await wrapper.get('li button').trigger('click')
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledWith('m:7', undefined, expect.any(AbortSignal))
    expect(wrapper.emitted('open')?.[0]?.[0]).toMatchObject({ seriesKey: 'm:7' })
  })

  it('shows one combined list with the source on each row', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => ({
      query: 'tower',
      hits:
        kind === 'manga'
          ? [hit(), hit({ seriesKey: 'm:8', title: 'Second Tower' }), hit({ seriesKey: 'm:9', title: 'Third Tower', sourceName: 'AllManga' })]
          : [],
      failedSources: [],
    }))
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.findAll('h2')).toHaveLength(0)
    const rows = wrapper.findAll('li')
    expect(rows.map((row) => row.get('p').text())).toEqual(['Tower Climber', 'Second Tower', 'Third Tower'])
    expect(rows[2]!.text()).toContain('AllManga')
  })

  it('sorts by title and by source, and remembers the choice', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => ({
      query: 'tower',
      hits:
        kind === 'manga'
          ? [
              hit({ seriesKey: 'm:1', title: 'Zeta Tower', sourceName: 'MangaDex' }),
              hit({ seriesKey: 'm:2', title: 'Beta Tower', sourceName: 'AllManga' }),
              hit({ seriesKey: 'm:3', title: 'Alpha Tower', sourceName: 'MangaDex' }),
            ]
          : [],
      failedSources: [],
    }))
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const titles = () => wrapper.findAll('li').map((row) => row.get('p').text())

    expect(titles()).toEqual(['Zeta Tower', 'Beta Tower', 'Alpha Tower'])
    await wrapper.get('select').setValue('title')
    expect(titles()).toEqual(['Alpha Tower', 'Beta Tower', 'Zeta Tower'])
    await wrapper.get('select').setValue('source')
    expect(titles()).toEqual(['Zeta Tower', 'Alpha Tower', 'Beta Tower'])
    expect(window.localStorage.getItem('bookorbit.webSerials.resultSort')).toBe('source')

    wrapper.unmount()
    const again = mount(WebSerialsSearchPanel)
    await flushPromises()
    await again.get('#web-serials-query').setValue('tower')
    await again.get('form').trigger('submit')
    await flushPromises()
    expect((again.get('select').element as HTMLSelectElement).value).toBe('source')
  })

  it('switches between comfortable and compact rows and remembers it', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => ({
      query: 'tower',
      hits: kind === 'manga' ? [hit()] : [],
      failedSources: [],
    }))
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-density="compact"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="Compact"]').trigger('click')
    expect(wrapper.find('[data-density="compact"]').exists()).toBe(true)
    expect(window.localStorage.getItem('bookorbit.webSerials.resultDensity')).toBe('compact')
    await wrapper.get('button[aria-label="Comfortable"]').trigger('click')
    expect(wrapper.find('[data-density="compact"]').exists()).toBe(false)
  })

  it('filters results by source from the source bar and hides it for a single source', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => ({
      query: 'tower',
      hits: kind === 'manga' ? [hit(), hit({ seriesKey: 'm:9', title: 'Third Tower', sourceName: 'AllManga' })] : [],
      failedSources: [],
    }))
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.text().replace(/\s+/g, ' '))).toEqual(['All 2', 'MangaDex 1', 'AllManga 1'])
    await radios[2]!.trigger('click')
    expect(wrapper.findAll('li').map((row) => row.get('p').text())).toEqual(['Third Tower'])

    api.searchSerials.mockImplementation(async () => ({ query: 'tower', hits: [hit()], failedSources: [] }))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
  })

  it('shows manga results while the novel search is still running', async () => {
    let finishNovel: (value: unknown) => void = () => undefined
    api.searchSerials.mockImplementation((_q: unknown, kind: unknown) =>
      kind === 'manga'
        ? Promise.resolve({ query: 'tower', hits: [hit()], failedSources: [] })
        : new Promise((resolve) => {
            finishNovel = resolve
          }),
    )
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()

    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Tower Climber')
    expect(wrapper.find('[data-testid="pending-manga"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="pending-novel"]').text()).toContain('Still searching novel sites...')

    finishNovel({
      query: 'tower',
      hits: [hit({ seriesKey: null, url: 'https://novelbuddy.com/x', kind: 'novel', title: 'Tower Novel', sourceName: 'novelbuddy.com' })],
      failedSources: [],
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="pending-novel"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Tower Novel')
  })

  it('tells the user when nothing is set up', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: false, searchable: false, defaultLibraryId: null, targetFolderId: null },
      novel: { available: false, searchable: false, acceptsLinks: false, defaultLibraryId: null, targetFolderId: null },
    })
    const wrapper = mount(WebSerialsSearchPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Manga & Light Novels is not set up yet')
  })
})

describe('WebSerialResultRow', () => {
  it('shows a spinner state while the hit is opening', () => {
    const wrapper = mount(WebSerialResultRow, { props: { hit: hit(), opening: true, disabled: true } })
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  it('names the kind once, as the chip beside the title', () => {
    const wrapper = mount(WebSerialResultRow, { props: { hit: hit(), opening: false, disabled: false } })
    expect(wrapper.text().match(/Manga(?!Dex)/g)).toHaveLength(1)
    expect(wrapper.text()).toContain('MangaDex')
  })
})

describe('WebSerialResultRow MTL chip', () => {
  it.each(['comfortable', 'compact'] as const)('marks a machine translation in %s density only', (density) => {
    const plain = mount(WebSerialResultRow, { props: { hit: hit(), opening: false, disabled: false, density } })
    const mtl = mount(WebSerialResultRow, { props: { hit: hit({ mtl: true }), opening: false, disabled: false, density } })
    expect(plain.find('[data-testid="mtl-chip"]').exists()).toBe(false)
    expect(mtl.get('[data-testid="mtl-chip"]').text()).toBe('MTL')
  })
})

describe('WebSerialPreviewSheet', () => {
  function mountSheet(detail = novelDetail()) {
    return mount(WebSerialPreviewSheet, { props: { detail, open: true }, global: { stubs: sheetStubs } })
  }

  it('offers per-volume and whole-series packaging for a novel', () => {
    const wrapper = mountSheet()
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('Per volume')
    expect(wrapper.text()).toContain('One book for the series')
    expect(wrapper.text()).toContain('3 volumes · 3 books · royalroad.com')
  })

  it('counts a single book once the series packaging is picked', async () => {
    const wrapper = mountSheet()
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true)
    expect(wrapper.text()).toContain('3 volumes · 1 book · royalroad.com')
  })

  const MANGA_OPTIONS = { packagingOptions: ['chapter', 'volume', 'series'] as WebSerialPackaging[] }

  function card(wrapper: ReturnType<typeof mountSheet>, index: number) {
    return wrapper.findAll('label').filter((label) => label.find('input[name="web-serials-packaging"]').exists())[index]!
  }

  function cardGroup(wrapper: ReturnType<typeof mountSheet>) {
    return wrapper.findAll('[role="radiogroup"]').find((group) => group.find('input[name="web-serials-packaging"]').exists())!
  }

  function volumeUnits(volumes: Record<string, string | null>) {
    return ['1', '2', '3', '4', '5'].map((sequence) => unit(sequence, { volume: volumes[sequence] ?? null }))
  }

  it('offers three packaging cards for manga in a three-column row', () => {
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(3)
    expect(cardGroup(wrapper).classes()).toContain('sm:grid-cols-3')
    expect(wrapper.text()).toContain('Per chapter')
    expect(wrapper.text()).toContain('One book for each chapter.')
    expect(wrapper.text()).toContain('One book')
    expect(wrapper.text()).toContain('5 chapters · 5 books · MangaDex')
  })

  it('disables Per volume when no chapter has a known volume', async () => {
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    await flushPromises()
    const volume = wrapper.findAll('input[type="radio"]')[1]
    expect(volume?.attributes('disabled')).toBeDefined()
    expect(card(wrapper, 1).attributes('aria-disabled')).toBe('true')
    expect(wrapper.text()).toContain("Volume information isn't available for this series.")
  })

  it('keeps Per volume locked with a spinner while the lookup loads', async () => {
    api.fetchSeriesLookup.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    await flushPromises()
    expect(wrapper.findAll('input[type="radio"]')[1]?.attributes('disabled')).toBeDefined()
    expect(card(wrapper, 1).find('.animate-spin').exists()).toBe(true)
  })

  it('groups chapters by the lookup volumes and explains the rest', async () => {
    api.fetchSeriesLookup.mockResolvedValue({
      state: 'no_match',
      match: null,
      message: null,
      chapterVolumes: { u1: '1', u2: '1', u3: '2' },
    })
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    await flushPromises()
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true)
    await wrapper.get('[data-testid="toggle-list"]').trigger('click')
    expect(wrapper.text()).toContain('5 chapters · 4 books · MangaDex')
    expect(wrapper.get('[data-testid="volume-notice-summary"]').text()).toBe('2 volumes, 2 single chapters')
    expect(wrapper.text()).toContain('2 chapters are not in a volume yet and will download as separate chapters')
    const chips = wrapper.findAll('[data-testid="unit-volume"]').map((chip) => chip.text())
    expect(chips).toEqual(['No volume', 'No volume', 'Vol. 2', 'Vol. 1', 'Vol. 1'])
  })

  it('lists the chapters outside volumes on demand', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'no_match', match: null, message: null, chapterVolumes: { u1: '1', u2: '1', u3: '2' } })
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    await flushPromises()
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true)
    await wrapper.get('[data-testid="volume-notice-outside"] button').trigger('click')
    expect(wrapper.get('[data-testid="volume-notice-list"]').text()).toBe('45')
    expect(wrapper.find('[data-testid="volume-notice-snapped"]').exists()).toBe(false)
  })

  it('prefers the volume in the chapter name over the lookup', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'no_match', match: null, message: null, chapterVolumes: { u1: '9' } })
    const wrapper = mountSheet(mangaDetail({ ...MANGA_OPTIONS, units: volumeUnits({ '1': '3', '2': '3' }) }))
    await flushPromises()
    await wrapper.findAll('input[type="radio"]')[1]?.setValue(true)
    await wrapper.get('[data-testid="toggle-list"]').trigger('click')
    expect(wrapper.text()).toContain('5 chapters · 4 books · MangaDex')
    expect(wrapper.text()).toContain('Vol. 3')
    expect(wrapper.text()).not.toContain('Vol. 9')
  })

  it('counts one book for the whole manga selection', async () => {
    const wrapper = mountSheet(mangaDetail(MANGA_OPTIONS))
    await wrapper.findAll('input[type="radio"]')[2]?.setValue(true)
    expect(wrapper.text()).toContain('5 chapters · 1 book · MangaDex')
  })

  it('narrows the count with a range and mentions what is already owned', async () => {
    const wrapper = mountSheet(mangaDetail({ importedUnitKeys: ['u1'] }))
    expect(wrapper.text()).toContain('1 already in your library')
    expect(wrapper.text()).toContain('5 chapters · 4 books · MangaDex')

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Choose range')
      ?.trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Ch. 2'))
      ?.trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Ch. 3'))
      ?.trigger('click')
    expect(wrapper.text()).toContain('Chapters 2 to 3 · 2 chapters')
    expect(wrapper.text()).toContain('2 chapters · 2 books · MangaDex')
  })

  it('shows newest units first and exposes each one as a button', async () => {
    const wrapper = mountSheet(mangaDetail())
    await wrapper.get('[data-testid="toggle-list"]').trigger('click')
    const unitButtons = wrapper.findAll('[role="listitem"] button')
    expect(unitButtons[0]?.text()).toContain('Ch. 5')
    expect(unitButtons.at(-1)?.text()).toContain('Ch. 1')
  })

  it('shows an in-sheet error with Retry when detail loading fails', async () => {
    const wrapper = mount(WebSerialPreviewSheet, {
      props: { detail: null, open: true, loadError: 'Source timed out.' },
      global: { stubs: sheetStubs },
    })
    expect(wrapper.text()).toContain('Source timed out.')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Retry')
      ?.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('shows the header and list skeleton while detail is loading', () => {
    const wrapper = mount(WebSerialPreviewSheet, {
      props: { detail: null, open: true, loading: true },
      global: { stubs: sheetStubs },
    })
    expect(wrapper.get('[aria-busy="true"]').attributes('aria-label')).toBe('Loading series details')
  })

  it('disables Get when every chapter is already in the library', () => {
    const wrapper = mountSheet(mangaDetail({ importedUnitKeys: ['u1', 'u2', 'u3', 'u4', 'u5'] }))
    expect(wrapper.text()).toContain('Nothing new to download')
    const get = wrapper.findAll('button').find((button) => button.text() === 'Get')
    expect(get?.attributes('disabled')).toBeDefined()
  })

  it('emits created with the job once Get succeeds', async () => {
    api.createSerialJob.mockResolvedValue(job({ id: 9 }))
    const wrapper = mountSheet(mangaDetail())
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Get')
      ?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ seriesKey: 'm:7', libraryId: 1, folderId: null }))
    expect(wrapper.emitted('created')?.[0]?.[0]).toMatchObject({ id: 9 })
  })
})

describe('WebSerialJobRow', () => {
  it('shows progress with skipped units counted and offers Cancel while active', async () => {
    const wrapper = mount(WebSerialJobRow, { props: { job: job(), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain('4 of 10')
    expect(wrapper.text()).toContain('Downloading')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('40')
    expect(wrapper.find('button[aria-label="Retry Tower Climber"]').exists()).toBe(false)

    await wrapper.get('button[aria-label="Cancel Tower Climber"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual(['cancel', expect.objectContaining({ id: 1 })])
  })

  it('counts books and names what the current book is doing when there are several', () => {
    const current = { label: 'Overgeared', stage: 'fetching' as const, chaptersDone: 1651, chaptersTotal: 2082, progress: 0.79 }
    const wrapper = mount(WebSerialJobRow, { props: { job: job({ current }), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain('4 of 10')
    expect(wrapper.text()).toContain('Now: Overgeared · Chapter 1,651 of 2,082')
    const bars = wrapper.findAll('[role="progressbar"]')
    expect(bars).toHaveLength(1)
    expect(bars[0]!.attributes('aria-valuenow')).toBe('48')
  })

  it('shows chapter progress as the whole story for a single book', () => {
    const current = { label: 'Overgeared', stage: 'fetching' as const, chaptersDone: 1798, chaptersTotal: 2082, progress: 0.86 }
    const wrapper = mount(WebSerialJobRow, {
      props: { job: job({ packaging: 'series', unitsTotal: 1, unitsDone: 0, unitsSkipped: 0, current }), busy: false },
      global: { stubs: uiStubs },
    })
    expect(wrapper.text()).toContain('Chapter 1,798 of 2,082')
    expect(wrapper.text()).toContain('86%')
    expect(wrapper.text()).not.toContain('Book 0 of 1')
    expect(wrapper.text()).not.toContain('Now:')
  })

  it.each([
    ['building', 'Building the book...'],
    ['importing', 'Adding to your library...'],
  ])('shows the %s stage without a bar', (stage, text) => {
    const current = { label: 'Overgeared', stage: stage as 'building' | 'importing', chaptersDone: null, chaptersTotal: null, progress: null }
    const wrapper = mount(WebSerialJobRow, { props: { job: job({ current }), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain(text)
    expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(1)
  })

  it('says Downloading for a single-chapter unit and keeps Fetching chapters for books', () => {
    const current = { label: 'Chapter 699.5', stage: 'fetching' as const, chaptersDone: null, chaptersTotal: null, progress: null }
    const chapterJob = mount(WebSerialJobRow, { props: { job: job({ packaging: 'chapter', current }), busy: false }, global: { stubs: uiStubs } })
    expect(chapterJob.text()).toContain('Now: Chapter 699.5 · Downloading...')
    expect(chapterJob.text()).not.toContain('Fetching chapters')
    const volumeJob = mount(WebSerialJobRow, { props: { job: job({ packaging: 'volume', current }), busy: false }, global: { stubs: uiStubs } })
    expect(volumeJob.text()).toContain('Fetching chapters...')
  })

  it('shows the waiting-to-retry message of an active job with the clock', () => {
    const message = "Waiting to retry 1 chapter: Mangabat isn't responding right now. Next try in 9 minutes."
    const wrapper = mount(WebSerialJobRow, { props: { job: job({ message }), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain(message)
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(true)
  })

  it('shows the retry notice of an active job as a muted line', () => {
    const message = "Mangabat isn't responding right now. Trying again in 2 minutes."
    const wrapper = mount(WebSerialJobRow, { props: { job: job({ message }), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain(message)
    expect(wrapper.find('svg.lucide-clock').exists()).toBe(true)
  })

  it('does not show the message of a finished job as a retry notice', () => {
    const wrapper = mount(WebSerialJobRow, {
      props: { job: job({ status: 'completed', message: 'old notice' }), busy: false },
      global: { stubs: { RouterLink: RouterLinkStub, ...uiStubs } },
    })
    expect(wrapper.text()).not.toContain('old notice')
  })

  it('does not claim the chapter is downloading while a retry is waiting', () => {
    const current = { label: 'Chapter 12', stage: 'fetching' as const, chaptersDone: null, chaptersTotal: null, progress: null }
    const message = 'Waiting to retry 1 chapter. Next try in 2 minutes.'
    const wrapper = mount(WebSerialJobRow, { props: { job: job({ current, message, unitsTotal: 1 }), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.text()).toContain(message)
    expect(wrapper.text()).not.toContain('Downloading...')
    expect(wrapper.text()).not.toContain('Now: Chapter 12')
  })

  it('shows the chapters left failed on a moved job that ended as Added', () => {
    const wrapper = mount(WebSerialJobRow, {
      props: { job: job({ status: 'completed', unitsFailed: 2, unitsDone: 8 }), busy: false },
      global: { stubs: { RouterLink: RouterLinkStub, ...uiStubs } },
    })
    expect(wrapper.text()).toContain('2 items could not be downloaded.')
  })

  it('shows nothing extra without current progress', () => {
    const wrapper = mount(WebSerialJobRow, { props: { job: job(), busy: false }, global: { stubs: uiStubs } })
    expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(1)
  })

  it('shows the message and Retry for a job that finished with gaps', async () => {
    const wrapper = mount(WebSerialJobRow, {
      props: {
        job: job({ status: 'completed_with_gaps', unitsDone: 7, unitsFailed: 3, message: '3 chapters could not be downloaded from MangaDex.' }),
        busy: false,
      },
      global: { stubs: uiStubs },
    })
    expect(wrapper.text()).toContain('Added with gaps')
    expect(wrapper.text()).toContain('3 chapters could not be downloaded from MangaDex.')
    expect(wrapper.text()).not.toContain('Cancel')

    await wrapper.get('button[aria-label="Retry Tower Climber"]').trigger('click')
    expect(wrapper.emitted('action')?.[0]?.[0]).toBe('retry')
  })

  it('links a completed job to its library', () => {
    const wrapper = mount(WebSerialJobRow, {
      props: { job: job({ status: 'completed' }), busy: false },
      global: { stubs: { RouterLink: RouterLinkStub, ...uiStubs } },
    })
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ name: 'library', params: { id: 3 } })
    expect(wrapper.find('a[aria-label="Open Tower Climber in its library"]').exists()).toBe(true)
  })
})
