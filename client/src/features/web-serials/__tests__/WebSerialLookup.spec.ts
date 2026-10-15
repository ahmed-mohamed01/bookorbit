import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialSeriesLookup, WebSerialSeriesMatch } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { job, mangaDetail, novelDetail } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<unknown>>(),
  fetchSeriesLookup: vi.fn<(key: string) => Promise<WebSerialSeriesLookup>>(),
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeriesSources: vi.fn<(key: string) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  const libraries = ref([{ id: 1, type: 'books', name: 'Manga', accessLevel: 'owner', folders: [{ id: 11, path: '/manga' }] }])
  return { useLibraries: () => ({ libraries, loaded: ref(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

import WebSerialPreviewSheet from '../components/WebSerialPreviewSheet.vue'
import { splitSourceAuthors } from '../composables/useWebSerialLookup'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const sheetStubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

const MATCH: WebSerialSeriesMatch = {
  provider: 'mangabaka',
  id: '1995',
  title: "Frieren: Beyond Journey's End",
  url: 'https://mangabaka.org/1995',
  year: 2020,
  authors: ['Kanehito Yamada'],
  artists: ['Tsukasa Abe'],
  status: 'ongoing',
  genres: ['Fantasy'],
}

const matched: WebSerialSeriesLookup = { state: 'matched', match: MATCH, message: null, chapterVolumes: null }

function mountSheet(detail = mangaDetail({ title: "Journey'S End", author: '' })) {
  return mount(WebSerialPreviewSheet, { props: { detail, open: true }, global: { plugins: [i18n], stubs: sheetStubs } })
}

function button(wrapper: ReturnType<typeof mountSheet>, text: string) {
  return wrapper.findAll('button').find((candidate) => candidate.text() === text)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(null)
  api.fetchSeriesSources.mockResolvedValue({ options: [], failedSources: [] })
  api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
})

describe('splitSourceAuthors', () => {
  it('splits the source credit into separate names', () => {
    expect(splitSourceAuthors('A. Writer, B. Writer; C')).toEqual(['A. Writer', 'B. Writer', 'C'])
    expect(splitSourceAuthors('')).toEqual([])
    expect(splitSourceAuthors(null)).toEqual([])
  })
})

describe('WebSerialPreviewSheet series lookup', () => {
  it('shows a looking-up line while the lookup is pending, without blocking the sheet', async () => {
    api.fetchSeriesLookup.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Looking up details...')
    expect(wrapper.text()).toContain('Chapters')
  })

  it('prefills credits from the match and shows the canonical title above the source title', async () => {
    api.fetchSeriesLookup.mockResolvedValue(matched)
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.get('h2').text()).toBe(MATCH.title)
    expect(wrapper.text()).toContain("Journey'S End")
    expect(wrapper.text()).toContain("Details from MangaBaka: Frieren: Beyond Journey's End (2020)")
    expect(wrapper.get('a[href="https://mangabaka.org/1995"]').attributes('target')).toBe('_blank')
    expect(wrapper.text()).toContain('Kanehito Yamada')
    expect(wrapper.text()).toContain('Tsukasa Abe')
    expect(wrapper.text()).toContain('/manga')
    expect(wrapper.text()).not.toContain('Kanehito Yamada/Frieren')
    expect(wrapper.text()).not.toContain('Books will be filed under Unknown author.')
  })

  it('falls back to the source values when the match is rejected', async () => {
    api.fetchSeriesLookup.mockResolvedValue(matched)
    const wrapper = mountSheet(mangaDetail({ title: "Journey'S End", author: 'Source Author' }))
    await flushPromises()
    await button(wrapper, 'Not this series')?.trigger('click')
    expect(wrapper.get('h2').text()).toBe("Journey'S End")
    expect(wrapper.text()).not.toContain('Kanehito Yamada')
    expect(wrapper.text()).toContain('Source Author')
    expect(wrapper.text()).toContain('Not using the MangaBaka match.')

    api.createSerialJob.mockResolvedValue(job())
    await button(wrapper, 'Get')?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ metadata: { matchId: null, authors: ['Source Author'] } }))
  })

  it('tells the user when nothing matched and warns about the unknown author folder', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'no_match', match: null, message: null, chapterVolumes: null })
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('No match found in the series database. Add the author yourself.')
    expect(wrapper.text()).toContain('Books will be filed under Unknown author.')
    const get = button(wrapper, 'Get')
    expect(get?.attributes('disabled')).toBeUndefined()
  })

  it('sends no empty credit lists when nothing matched and no author is known', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'no_match', match: null, message: null, chapterVolumes: null })
    api.createSerialJob.mockResolvedValue(job())
    const wrapper = mountSheet()
    await flushPromises()
    await button(wrapper, 'Get')?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ metadata: { matchId: null } }))
  })

  it('keeps Get disabled while the series lookup is still loading', async () => {
    api.fetchSeriesLookup.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountSheet()
    await flushPromises()
    expect(button(wrapper, 'Get')?.attributes('disabled')).toBeDefined()
  })

  it('shows the server message with a Retry that looks the series up again', async () => {
    api.fetchSeriesLookup.mockResolvedValueOnce({
      state: 'unavailable',
      match: null,
      message: 'Series details could not be looked up right now.',
      chapterVolumes: null,
    })
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Series details could not be looked up right now.')

    api.fetchSeriesLookup.mockResolvedValueOnce(matched)
    await button(wrapper, 'Retry')?.trigger('click')
    await flushPromises()
    expect(api.fetchSeriesLookup).toHaveBeenCalledTimes(2)
    expect(wrapper.get('h2').text()).toBe(MATCH.title)
  })

  it('treats a failed lookup request as unavailable', async () => {
    api.fetchSeriesLookup.mockRejectedValue(new Error('offline'))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('offline')
    expect(button(wrapper, 'Retry')).toBeDefined()
  })

  it('shows nothing extra when the lookup is disabled', async () => {
    const wrapper = mountSheet(mangaDetail({ author: 'Kim Lee' }))
    await flushPromises()
    expect(wrapper.text()).not.toContain('MangaBaka')
    expect(wrapper.text()).not.toContain('Retry')
    expect(wrapper.text()).toContain('Kim Lee')
  })

  it('sends the confirmed match and credits when Get is pressed', async () => {
    api.fetchSeriesLookup.mockResolvedValue(matched)
    api.createSerialJob.mockResolvedValue(job())
    const wrapper = mountSheet()
    await flushPromises()
    await button(wrapper, 'Get')?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { matchId: '1995', authors: ['Kanehito Yamada'], artists: ['Tsukasa Abe'] } }),
    )
  })

  it('leaves artists out for a novel', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'matched', match: { ...MATCH, artists: [] }, message: null, chapterVolumes: null })
    api.createSerialJob.mockResolvedValue(job({ kind: 'novel' }))
    const wrapper = mountSheet(novelDetail({ author: null }))
    await flushPromises()
    expect(wrapper.find('#web-serials-artists').exists()).toBe(false)
    await button(wrapper, 'Get')?.trigger('click')
    await flushPromises()
    expect(api.createSerialJob).toHaveBeenCalledWith(expect.objectContaining({ metadata: { matchId: '1995', authors: ['Kanehito Yamada'] } }))
  })
})
