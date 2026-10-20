import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialSeriesLookup, WebSerialSeriesMatch, WebSerialSourceOption } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { catalogEntry, mangaDetail, novelDetail, suggestion } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<unknown>>(),
  fetchSeriesLookup: vi.fn<(...args: unknown[]) => Promise<WebSerialSeriesLookup>>(),
  fetchSeriesSources: vi.fn<(key: string) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchDiscoverSources: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createSerialJob: vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref } = await import('vue')
  const libraries = ref([{ id: 1, type: 'books', name: 'Novels', accessLevel: 'owner', folders: [{ id: 11, path: '/novels' }] }])
  return { useLibraries: () => ({ libraries, loaded: ref(true), fetchLibraries: vi.fn<() => Promise<void>>() }) }
})

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))

import WebSerialPreviewSheet from '../components/WebSerialPreviewSheet.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const publishedStub = defineComponent({ template: '<section data-testid="published-volumes" />' })
const stubs = {
  Sheet: passthrough,
  SheetContent: passthrough,
  SheetTitle: passthrough,
  SheetDescription: passthrough,
  WebSerialPublishedVolumes: publishedStub,
  LnAcquisitionSection: defineComponent({ template: '<section data-testid="acquisition-section" />' }),
}

const ARC: WebSerialSeriesMatch = {
  provider: 'mangabaka',
  id: '20',
  title: 'The Water Magician: The Central Provinces Arc',
  url: 'https://mangabaka.org/20',
  year: 2021,
  authors: ['Tadashi Kubou'],
  artists: [],
  status: 'ongoing',
  genres: ['Fantasy'],
  publication: { licensed: true, finalVolume: 4, publishers: [] },
}

const lookupOf = (match: WebSerialSeriesMatch): WebSerialSeriesLookup => ({ state: 'matched', match, message: null, chapterVolumes: null })
const option = (overrides: Partial<WebSerialSourceOption> = {}): WebSerialSourceOption => ({
  seriesKey: 'n:3',
  sourceName: 'Novel Fire',
  title: 'Water Magician',
  chapterCount: 800,
  latestAt: null,
  confidence: 'same_series',
  mostComplete: true,
  ...overrides,
})

function mountSheet(props: Record<string, unknown> = {}) {
  return mount(WebSerialPreviewSheet, {
    props: { detail: novelDetail({ title: 'Water Magician' }), open: true, ...props },
    global: { plugins: [i18n], stubs },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(null)
  api.fetchSeriesSources.mockResolvedValue({ options: [option()], failedSources: [] })
})

describe('published volumes in the preview of a site series', () => {
  it('a novel in print renders the acquisition section before sources and keeps sources collapsed', async () => {
    api.fetchSeriesLookup.mockResolvedValue(lookupOf(ARC))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.find('[data-testid="acquisition-section"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Light novel')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Get')).toBe(false)
    const toggle = wrapper.get('[data-testid="web-sources-disclosure"] button')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[id="web-serial-units-novel"]').exists()).toBe(false)
    await toggle.trigger('click')
    expect(wrapper.find('[id="web-serial-units-novel"]').exists()).toBe(true)
  })

  it('has no print line for a series that is not licensed', async () => {
    api.fetchSeriesLookup.mockResolvedValue(lookupOf({ ...ARC, publication: { licensed: false, finalVolume: null, publishers: [] } }))
    const wrapper = mountSheet()
    await flushPromises()

    expect(wrapper.find('[data-testid="published-disclosure"]').exists()).toBe(false)
  })

  it('shows no print volumes for a part match and names the whole series in the header', async () => {
    api.fetchSeriesLookup.mockResolvedValue(lookupOf({ ...ARC, scope: 'part' }))
    const wrapper = mountSheet()
    await flushPromises()

    expect(wrapper.find('[data-testid="published-disclosure"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="published-volumes"]').exists()).toBe(false)
    expect(wrapper.get('h2').text()).toBe('The Water Magician')
    expect(wrapper.text()).toContain('Details from MangaBaka: The Water Magician: The Central Provinces Arc (first part of the series)')
    expect(wrapper.text()).toContain('Fantasy')
  })

  it('treats a whole-series source like a part match', async () => {
    api.fetchSeriesLookup.mockResolvedValue(lookupOf(ARC))
    api.fetchSeriesSources.mockResolvedValue({ options: [option({ confidence: 'whole_series' })], failedSources: [] })
    const wrapper = mountSheet()
    await flushPromises()

    expect(wrapper.find('[data-testid="published-disclosure"]').exists()).toBe(false)
    expect(wrapper.get('h2').text()).toBe('The Water Magician')
  })

  it('keeps the full match title for an ordinary match', async () => {
    api.fetchSeriesLookup.mockResolvedValue(lookupOf(ARC))
    const wrapper = mountSheet()
    await flushPromises()

    expect(wrapper.get('h2').text()).toBe('The Water Magician: The Central Provinces Arc')
  })
})

describe('WebSerialPreviewSheet opened from a suggestion', () => {
  const copies = [
    { sourceId: 'm', sourceName: 'MTL Site', path: 'm', mtl: true, seriesKey: 'nl:m' },
    { sourceId: 'a', sourceName: 'Novel Fire', path: 'a', mtl: false, seriesKey: 'nl:a' },
    { sourceId: 'b', sourceName: 'NovelBuddy', path: 'b', mtl: false, seriesKey: 'nl:b' },
  ]

  it('counts chapters, not volumes, for a copy whose units are 100-chapter volumes', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
    api.fetchSeries.mockImplementation(async (key: unknown) =>
      novelDetail({
        seriesKey: key as string,
        sourceName: key as string,
        units: [
          { key: 'v1', label: 'Volume 1', sequence: '1', chapterCount: 100, publishedAt: null },
          { key: 'v2', label: 'Volume 2', sequence: '2', chapterCount: 82, publishedAt: null },
        ],
      }),
    )

    const wrapper = mountSheet({ detail: null, suggestion: suggestion({ title: 'Water Magician', entries: copies.slice(1) }) })
    await flushPromises()

    const rows = wrapper.findAll('label').filter((label) => label.find('input[name="web-serials-source"]').exists())
    expect(rows[0]!.text()).toContain('182 chapters')
    expect(rows[1]!.text()).toContain('182 chapters')
  })

  it('lists all copies, opens the first non-MTL one and counts the others afterwards', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
    api.fetchSeries.mockImplementation(async (key: unknown) => {
      const units = key === 'nl:a' ? ['1', '2', '3'] : ['1']
      return novelDetail({
        seriesKey: key as string,
        sourceName: key as string,
        units: units.map((sequence) => ({ key: `u${sequence}`, label: `Ch. ${sequence}`, sequence, chapterCount: 1, publishedAt: null })),
      })
    })

    const wrapper = mountSheet({ detail: null, suggestion: suggestion({ title: 'Water Magician', entries: copies }) })
    await flushPromises()

    expect(api.fetchDiscoverSources).not.toHaveBeenCalled()
    expect(api.fetchSeries.mock.calls[0]).toEqual(['nl:a', undefined, expect.any(AbortSignal)])
    const radios = wrapper.findAll('input[name="web-serials-source"]')
    expect(radios.map((radio) => (radio.element as HTMLInputElement).value)).toEqual(['nl:m', 'nl:a', 'nl:b'])
    expect((radios[1]!.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.find('[data-testid="mtl-chip"]').exists()).toBe(true)
    const rows = wrapper.findAll('label').filter((label) => label.find('input[name="web-serials-source"]').exists())
    expect(rows[1]!.text()).toContain('3 chapters')
    expect(rows[2]!.text()).toContain('1 chapter')
    expect(rows[1]!.text()).toContain('Most complete')
    expect(wrapper.get('h2').text()).toBe('The Long Night')
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === 'Get')!
        .attributes('disabled'),
    ).toBeUndefined()
  })

  it('gets credits from the series database when the suggestion is matched', async () => {
    api.fetchSeries.mockResolvedValue(novelDetail({ seriesKey: 'nl:a' }))
    api.fetchSeriesLookup.mockResolvedValue({ state: 'disabled', match: null, message: null, chapterVolumes: null })
    const entry = {
      matchId: '777',
      kind: 'novel',
      title: 'Water Magician',
      authors: ['Tadashi Kubou'],
      artists: [],
      year: null,
      status: 'unknown',
      genres: [],
      synopsis: null,
      coverUrl: null,
      url: 'https://mangabaka.org/777',
      inLibrary: false,
    } as const

    const wrapper = mountSheet({ detail: null, entry, suggestion: suggestion({ matchId: '777', entries: copies }) })
    await flushPromises()

    expect(api.fetchSeries.mock.calls[0]).toEqual(['nl:a', '777', expect.any(AbortSignal)])
    expect(api.fetchSeriesLookup).toHaveBeenCalledWith('nl:a', '777')
    expect(wrapper.get('h2').text()).toBe('Water Magician')
  })
})

it('keeps discover source lookup lazy until the web sources disclosure is opened', async () => {
  api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: [] })
  const wrapper = mountSheet({
    detail: null,
    entry: catalogEntry({ kind: 'novel', publication: { licensed: true, finalVolume: 4, publishers: [] } }),
  })
  await flushPromises()
  expect(api.fetchDiscoverSources).not.toHaveBeenCalled()
  expect(wrapper.find('[data-testid="acquisition-section"]').exists()).toBe(true)
  await wrapper.get('[data-testid="web-sources-disclosure"] button').trigger('click')
  await flushPromises()
  expect(api.fetchDiscoverSources).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('manga keeps the published disclosure and source picker layout', async () => {
  api.fetchSeriesLookup.mockResolvedValue(lookupOf(ARC))
  const wrapper = mountSheet({ detail: mangaDetail() })
  await flushPromises()
  expect(wrapper.find('[data-testid="acquisition-section"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="web-sources-disclosure"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="published-disclosure"]').exists()).toBe(true)
  wrapper.unmount()
})
