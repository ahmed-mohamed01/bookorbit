import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialSeriesLookup, WebSerialSourceOption, WebSerialSourceOptions } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { job, mangaDetail } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<unknown>>(),
  fetchSeriesLookup: vi.fn<(key: string) => Promise<WebSerialSeriesLookup>>(),
  fetchSeries: vi.fn<(key: string) => Promise<unknown>>(),
  fetchSeriesSources: vi.fn<(key: string) => Promise<WebSerialSourceOptions>>(),
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  const libraries = ref([
    { id: 1, type: 'books', name: 'Manga', accessLevel: 'owner', folders: [{ id: 11, path: '/manga' }] },
    { id: 2, type: 'books', name: 'Comics', accessLevel: 'owner', folders: [{ id: 21, path: '/comics' }] },
  ])
  return { useLibraries: () => ({ libraries, loaded: ref(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

import WebSerialPreviewSheet from '../components/WebSerialPreviewSheet.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const sheetStubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

function option(overrides: Partial<WebSerialSourceOption> = {}): WebSerialSourceOption {
  return {
    seriesKey: 'm:7',
    sourceName: 'MangaDex',
    title: 'Tower Climber',
    chapterCount: 5,
    latestAt: null,
    confidence: 'current',
    mostComplete: false,
    ...overrides,
  }
}

const TWO: WebSerialSourceOptions = {
  options: [
    option(),
    option({
      seriesKey: 'm:9',
      sourceName: 'Royal Road',
      chapterCount: 1048,
      latestAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      confidence: 'same_series',
      mostComplete: true,
    }),
    option({ seriesKey: 'm:11', sourceName: 'Other Site', chapterCount: 1, confidence: 'title_match' }),
  ],
  failedSources: [],
}

function mountSheet(detail = mangaDetail()) {
  return mount(WebSerialPreviewSheet, { props: { detail, open: true }, global: { plugins: [i18n], stubs: sheetStubs } })
}

function sourceRadios(wrapper: ReturnType<typeof mountSheet>) {
  return wrapper.findAll('input[name="web-serials-source"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(null)
  api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
  api.fetchSeriesSources.mockResolvedValue(TWO)
})

describe('WebSerialPreviewSheet download source', () => {
  it('lists each source with its chapters, freshness, badge and match chip', async () => {
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Download from')
    expect(sourceRadios(wrapper)).toHaveLength(3)
    expect(wrapper.text()).toContain('1,048 chapters')
    expect(wrapper.text()).toContain('1 chapter')
    expect(wrapper.text()).toMatch(/1,048 chapters · updated .*2 days? ago/)
    expect(wrapper.text()).toContain('Most complete')
    expect(wrapper.text()).toContain('Same series')
    expect(wrapper.text()).toContain('Title match')
    expect((sourceRadios(wrapper)[0]!.element as HTMLInputElement).checked).toBe(true)
    expect((sourceRadios(wrapper)[1]!.element as HTMLInputElement).checked).toBe(false)
  })

  it('omits the date part when the source reports no dates', async () => {
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('5 chapters')
    expect(wrapper.text()).not.toContain('5 chapters · updated')
  })

  it('labels the credits section for screen readers without a visible heading', async () => {
    const wrapper = mountSheet(mangaDetail({ author: 'Kim Lee' }))
    await flushPromises()
    const credits = wrapper.findComponent({ name: 'WebSerialCredits' })
    expect(credits.find('h3').exists()).toBe(false)
    expect(credits.get('section').attributes('aria-label')).toBe('Credits')
    expect(credits.text()).toContain('Authors')
  })

  it('switches to the chosen source, keeping edited credits and library, and downloads from it', async () => {
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9', sourceName: 'Royal Road', author: 'Someone Else' }))
    const wrapper = mountSheet(mangaDetail({ author: 'Kim Lee' }))
    await flushPromises()
    await wrapper.get('select#web-serials-library').setValue('2')
    const credits = wrapper.findComponent({ name: 'WebSerialCredits' })
    credits.vm.$emit('update:authors', ['My Edit'])
    await flushPromises()

    await sourceRadios(wrapper)[1]?.setValue(true)
    await flushPromises()

    expect(api.fetchSeries).toHaveBeenCalledWith('m:9', undefined, expect.any(AbortSignal))
    expect(api.fetchSeriesSources).toHaveBeenCalledTimes(1)
    expect((sourceRadios(wrapper)[1]!.element as HTMLInputElement).checked).toBe(true)
    expect((sourceRadios(wrapper)[0]!.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('My Edit')
    expect(wrapper.text()).not.toContain('Someone Else')
    expect((wrapper.get('select#web-serials-library').element as HTMLSelectElement).value).toBe('2')

    api.createSerialJob.mockResolvedValue(job())
    const get = wrapper.findAll('button').find((candidate) => candidate.text() === 'Get')
    await get?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesKey: 'm:9',
        libraryId: 2,
        selection: { mode: 'all' },
        metadata: expect.objectContaining({ authors: ['My Edit'] }),
      }),
    )
  })

  it('keeps Get disabled while the chosen source is still loading', async () => {
    let finish: (value: unknown) => void = () => undefined
    api.fetchSeries.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const wrapper = mountSheet()
    await flushPromises()
    await sourceRadios(wrapper)[1]?.setValue(true)
    const get = () => wrapper.findAll('button').find((candidate) => candidate.text() === 'Get')
    expect(get()?.attributes('disabled')).toBeDefined()
    finish(mangaDetail({ seriesKey: 'm:9', sourceName: 'Royal Road' }))
    await flushPromises()
    expect(get()?.attributes('disabled')).toBeUndefined()
  })

  it('resets the chapter range when the source changes', async () => {
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9', sourceName: 'Royal Road' }))
    const wrapper = mountSheet()
    await flushPromises()
    const rows = wrapper.findAll('button').filter((candidate) => candidate.text() === 'Latest 10')
    await rows[0]?.trigger('click')
    await sourceRadios(wrapper)[1]?.setValue(true)
    await flushPromises()
    api.createSerialJob.mockResolvedValue(job())
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === 'Get')
      ?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ selection: { mode: 'all' } }))
  })

  it('shows an error and keeps the current source when the switch fails', async () => {
    api.fetchSeries.mockRejectedValue(new Error('Source is down'))
    const wrapper = mountSheet()
    await flushPromises()
    await sourceRadios(wrapper)[1]?.setValue(true)
    await flushPromises()
    expect(wrapper.text()).toContain('Source is down')
    expect((sourceRadios(wrapper)[0]!.element as HTMLInputElement).checked).toBe(true)
  })

  it('is hidden when only the current source exists', async () => {
    api.fetchSeriesSources.mockResolvedValue({ options: [option()], failedSources: [] })
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Download from')
    expect(wrapper.text()).toContain('Chapters')
  })

  it('shows two skeleton rows while loading without blocking the sheet', async () => {
    api.fetchSeriesSources.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Download from')
    expect(wrapper.findAll('[aria-busy="true"] > div')).toHaveLength(2)
    expect(wrapper.text()).toContain('Chapters')
  })

  it('is hidden when the lookup fails', async () => {
    api.fetchSeriesSources.mockRejectedValue(new Error('nope'))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Download from')
    expect(wrapper.text()).toContain('Chapters')
  })

  it('moves focus with the arrow keys without loading each source it passes', async () => {
    const wrapper = mount(WebSerialPreviewSheet, {
      props: { detail: mangaDetail(), open: true },
      attachTo: document.body,
      global: { plugins: [i18n], stubs: sheetStubs },
    })
    await flushPromises()
    const radios = sourceRadios(wrapper)
    ;(radios[0]!.element as HTMLInputElement).focus()
    await radios[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(radios[1]!.element)
    expect(api.fetchSeries).not.toHaveBeenCalled()
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9', sourceName: 'Royal Road' }))
    await radios[1]!.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledWith('m:9', undefined, expect.any(AbortSignal))
    wrapper.unmount()
  })
})
