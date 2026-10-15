import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { WebSerialErrorCode } from '@bookorbit/types'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { hit, mangaDetail, novelDetail } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown, signal?: AbortSignal) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import { WebSerialApiError } from '../api/http'
import { hitIdentity, useWebSerialSearch } from '../composables/useWebSerialSearch'

beforeEach(() => {
  vi.clearAllMocks()
  api.discoverSerials.mockResolvedValue({ results: [], fallback: 'disabled' })
})

describe('useWebSerialSearch', () => {
  it('detects a pasted link and not a title', () => {
    const search = useWebSerialSearch()
    search.query.value = 'https://www.royalroad.com/fiction/1/x'
    expect(search.isLink.value).toBe(true)
    search.query.value = 'Tower Climber'
    expect(search.isLink.value).toBe(false)
  })

  it('needs two characters to search but not to open a link', () => {
    const search = useWebSerialSearch()
    search.query.value = 'a'
    expect(search.canSubmit.value).toBe(false)
    search.query.value = 'ab'
    expect(search.canSubmit.value).toBe(true)
  })

  it('searches by title in the chosen scope', async () => {
    api.searchSerials.mockResolvedValue({ query: 'tower', hits: [hit()], failedSources: ['Slow Source'] })
    const search = useWebSerialSearch()
    search.query.value = ' tower '
    search.setScope('manga')

    await expect(search.submit()).resolves.toBeNull()

    expect(api.searchSerials).toHaveBeenCalledWith('tower', 'manga', expect.any(AbortSignal), false)
    expect(search.hits.value).toHaveLength(1)
    expect(search.failedSources.value).toEqual(['Slow Source'])
    expect(search.hasSearched.value).toBe(true)
  })

  it('turns the all-disabled code into a notice instead of a failed source', async () => {
    api.searchSerials.mockResolvedValue({ query: 'tower', hits: [], failedSources: ['WEB_SERIAL_NOVEL_SOURCES_ALL_DISABLED'] })
    const search = useWebSerialSearch()
    search.query.value = 'tower'
    search.setScope('novel')
    await search.submit()
    expect(search.novelSourcesDisabled.value).toBe(true)
    expect(search.failedSources.value).toEqual([])
    api.searchSerials.mockResolvedValue({ query: 'tower', hits: [], failedSources: [] })
    await search.submit()
    expect(search.novelSourcesDisabled.value).toBe(false)
  })

  it('runs manga and novel as two parallel requests for the All scope and fills each as it resolves', async () => {
    let finishNovel: (value: unknown) => void = () => undefined
    api.searchSerials.mockImplementation((_q: unknown, kind: unknown) =>
      kind === 'manga'
        ? Promise.resolve({ query: 'tower', hits: [hit()], failedSources: [] })
        : new Promise((resolve) => {
            finishNovel = resolve
          }),
    )
    const search = useWebSerialSearch()
    search.query.value = 'tower'

    const pending = search.submit()
    await Promise.resolve()
    await Promise.resolve()
    expect(api.searchSerials).toHaveBeenCalledWith('tower', 'manga', expect.any(AbortSignal), false)
    expect(api.searchSerials).toHaveBeenCalledWith('tower', 'novel', expect.any(AbortSignal), false, 'index')
    expect(search.hits.value).toHaveLength(1)
    expect(search.pendingKinds.value).toEqual(['novel'])
    expect(search.searching.value).toBe(true)

    finishNovel({ query: 'tower', hits: [hit({ seriesKey: null, url: 'https://x.com/n', kind: 'novel' })], failedSources: [] })
    await pending
    expect(search.hits.value).toHaveLength(2)
    expect(search.searching.value).toBe(false)
    expect(search.hasSearched.value).toBe(true)
  })

  it('shows novel index hits at once and replaces them with the full answer only while sources are still unindexed', async () => {
    let finishLive: (value: unknown) => void = () => undefined
    api.searchSerials.mockImplementation((_q: unknown, _kind: unknown, _signal: unknown, _refresh: unknown, phase: unknown) =>
      phase === 'index'
        ? Promise.resolve({ query: 'omni', hits: [hit({ kind: 'novel', seriesKey: 'nl:a:x' })], failedSources: [], livePending: true })
        : new Promise((resolve) => {
            finishLive = resolve
          }),
    )
    const search = useWebSerialSearch()
    search.query.value = 'omni'
    search.setScope('novel')

    const pending = search.searchSites()
    await flushPromises()
    expect(search.hits.value.map((entry) => entry.seriesKey)).toEqual(['nl:a:x'])
    expect(search.pendingKinds.value).toEqual(['novel'])
    expect(api.searchSerials).toHaveBeenLastCalledWith('omni', 'novel', expect.any(AbortSignal), false)

    finishLive({ query: 'omni', hits: [hit({ kind: 'novel', seriesKey: 'nl:a:x' }), hit({ kind: 'novel', seriesKey: 'nl:b:y' })], failedSources: [] })
    await pending
    expect(search.hits.value).toHaveLength(2)
    expect(search.pendingKinds.value).toEqual([])
  })

  it('stops at the index answer once every novel source is indexed', async () => {
    api.searchSerials.mockResolvedValue({ query: 'omni', hits: [hit({ kind: 'novel', seriesKey: 'nl:a:x' })], failedSources: [] })
    const search = useWebSerialSearch()
    search.query.value = 'omni'
    search.setScope('novel')

    await search.searchSites()

    expect(api.searchSerials).toHaveBeenCalledTimes(1)
    expect(search.hits.value).toHaveLength(1)
  })

  it('skips a kind that is not searchable', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
      novel: { available: true, searchable: false, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    })
    api.searchSerials.mockResolvedValue({ query: 'tower', hits: [], failedSources: [] })
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    search.query.value = 'tower'
    await search.submit()
    expect(api.searchSerials).toHaveBeenCalledTimes(1)
    expect(api.searchSerials).toHaveBeenCalledWith('tower', 'manga', expect.any(AbortSignal), false)
  })

  it('ignores results of an older query that resolve after a newer one', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    api.searchSerials.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const search = useWebSerialSearch()
    search.setScope('manga')
    search.query.value = 'old'
    const first = search.submit()
    await flushPromises()
    search.query.value = 'new'
    const second = search.submit()
    await flushPromises()
    resolvers[1]!({ query: 'new', hits: [hit({ title: 'New' })], failedSources: [] })
    await second
    resolvers[0]!({ query: 'old', hits: [hit({ title: 'Old' })], failedSources: [] })
    await first
    expect(search.hits.value.map((item) => item.title)).toEqual(['New'])
  })

  it('reports a search error only when every kind failed, and a partial failure as a failed source', async () => {
    api.searchSerials.mockImplementation(async (_q: unknown, kind: unknown) => {
      if (kind === 'novel') throw new Error('engine down')
      return { query: 'tower', hits: [hit()], failedSources: [] }
    })
    const search = useWebSerialSearch()
    search.query.value = 'tower'
    await search.submit()
    expect(search.searchError.value).toBeNull()
    expect(search.failedSources.value).toEqual(['novel'])

    api.searchSerials.mockRejectedValue(new Error('all down'))
    await search.submit()
    expect(search.searchError.value).toBe('all down')
  })

  it('resolves a pasted link instead of searching', async () => {
    api.resolveSerialUrl.mockResolvedValue(novelDetail())
    const search = useWebSerialSearch()
    search.query.value = 'https://www.royalroad.com/fiction/1/x'

    const detail = await search.submit()

    expect(api.resolveSerialUrl).toHaveBeenCalledWith({ url: 'https://www.royalroad.com/fiction/1/x' }, expect.any(AbortSignal))
    expect(api.searchSerials).not.toHaveBeenCalled()
    expect(detail?.seriesKey).toBe('n:3')
  })

  it('shows the server message when a link cannot be opened', async () => {
    api.resolveSerialUrl.mockRejectedValue(new Error('Links work for web novels. For manga, search by title.'))
    const search = useWebSerialSearch()
    search.query.value = 'https://example.com/manga/1'
    await expect(search.submit()).resolves.toBeNull()
    expect(search.error.value).toBe('Links work for web novels. For manga, search by title.')
  })

  it('opens a keyed hit through the series endpoint', async () => {
    api.fetchSeries.mockResolvedValue(mangaDetail())
    const search = useWebSerialSearch()
    await expect(search.openHit(hit())).resolves.toMatchObject({ seriesKey: 'm:7' })
    expect(api.fetchSeries).toHaveBeenCalledWith('m:7', undefined, expect.any(AbortSignal))
    expect(search.openingKey.value).toBeNull()
  })

  it('resolves a novel hit that has only a url', async () => {
    api.resolveSerialUrl.mockResolvedValue(novelDetail())
    const search = useWebSerialSearch()
    const urlHit = hit({ seriesKey: null, url: 'https://novelbuddy.com/novel/x', kind: 'novel' })

    await expect(search.openHit(urlHit)).resolves.toMatchObject({ seriesKey: 'n:3' })
    expect(api.resolveSerialUrl).toHaveBeenCalledWith({ url: 'https://novelbuddy.com/novel/x' }, expect.any(AbortSignal))
    expect(api.fetchSeries).not.toHaveBeenCalled()
    expect(hitIdentity(urlHit)).toBe('https://novelbuddy.com/novel/x')
  })

  it('aborts a pending link resolve when the preview closes, so the next hit opens at once', async () => {
    const signals: AbortSignal[] = []
    api.resolveSerialUrl.mockImplementationOnce(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!)
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    api.fetchSeries.mockResolvedValue(mangaDetail())
    const search = useWebSerialSearch()
    const first = search.openHit(hit({ seriesKey: null, url: 'https://novelbuddy.com/novel/long', kind: 'novel' }))
    await flushPromises()

    search.cancelPreview()

    await expect(first).resolves.toBeNull()
    expect(signals[0]!.aborted).toBe(true)
    expect(search.openingKey.value).toBeNull()
    expect(search.previewError.value).toBeNull()
    await expect(search.openHit(hit())).resolves.toMatchObject({ seriesKey: 'm:7' })
  })

  it('frees the Open button when a pasted link is cancelled mid-resolve', async () => {
    api.resolveSerialUrl.mockImplementationOnce(
      (_input, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )
    const search = useWebSerialSearch()
    search.query.value = 'https://www.royalroad.com/fiction/1/x'
    const resolving = search.submit()
    await flushPromises()
    expect(search.resolvingLink.value).toBe(true)

    search.cancelPreview()

    await expect(resolving).resolves.toBeNull()
    expect(search.resolvingLink.value).toBe(false)
    expect(search.canSubmit.value).toBe(true)
  })

  it('reports links-only novels and narrows the scopes to what is available', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
      novel: { available: true, searchable: false, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    })
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    expect(search.novelLinksOnly.value).toBe(true)
    expect(search.availableScopes.value).toEqual(['all', 'manga', 'novel'])

    api.fetchCapabilities.mockResolvedValue({
      manga: { available: false, searchable: false, defaultLibraryId: null, targetFolderId: null },
      novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    })
    await search.loadCapabilities()
    expect(search.availableScopes.value).toEqual(['novel'])
    expect(search.scope.value).toBe('novel')
  })

  it('flags an instance with no source connected', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: false, searchable: false, defaultLibraryId: null, targetFolderId: null },
      novel: { available: false, searchable: false, acceptsLinks: false, defaultLibraryId: null, targetFolderId: null },
    })
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    expect(search.nothingAvailable.value).toBe(true)
  })

  it('keeps the page usable when capabilities fail to load', async () => {
    api.fetchCapabilities.mockRejectedValue(new Error('boom'))
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    expect(search.capabilitiesFailed.value).toBe(true)
    expect(search.nothingAvailable.value).toBe(false)
  })
})

describe('useWebSerialSearch source filter', () => {
  const BOTH = {
    manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
    novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
  }

  it('filters by source, keeps a surviving selection, falls back to All, and resets on a new search', async () => {
    let finishNovel: (value: unknown) => void = () => undefined
    api.fetchCapabilities.mockResolvedValue(BOTH)
    api.searchSerials.mockImplementation((_q: unknown, kind: unknown) =>
      kind === 'manga'
        ? Promise.resolve({ query: 'tower', hits: [hit(), hit({ seriesKey: 'm:2', sourceName: 'AllManga' })], failedSources: [] })
        : new Promise((resolve) => {
            finishNovel = resolve
          }),
    )
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    search.query.value = 'tower'
    const pending = search.submit()
    await Promise.resolve()
    await Promise.resolve()

    expect(search.sourceOptions.value.map((option) => option.sourceName)).toEqual(['MangaDex', 'AllManga'])
    search.setSource('AllManga')
    expect(search.visibleHits.value).toHaveLength(1)

    finishNovel({ query: 'tower', hits: [hit({ seriesKey: null, url: 'https://x/y', kind: 'novel', sourceName: 'Royal Road' })], failedSources: [] })
    await pending
    expect(search.activeSource.value).toBe('AllManga')
    expect(search.sourceOptions.value).toHaveLength(3)

    search.setSource('Gone')
    expect(search.activeSource.value).toBeNull()
    expect(search.visibleHits.value).toHaveLength(3)

    search.setSource('AllManga')
    api.searchSerials.mockResolvedValue({ query: 'tower', hits: [hit()], failedSources: [] })
    await search.submit()
    expect(search.activeSource.value).toBeNull()
  })
  it('says search is unavailable when All has no searchable kind instead of showing no results', async () => {
    api.fetchCapabilities.mockResolvedValue({
      manga: { available: true, searchable: false, defaultLibraryId: null, targetFolderId: null },
      novel: { available: true, searchable: false, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
    })
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    search.query.value = 'tower'
    await search.submit()
    expect(api.searchSerials).not.toHaveBeenCalled()
    expect(search.searchError.value).toContain('Search is not set up')
    expect(search.searching.value).toBe(false)
  })

  it('hides a machine translation that has a regular twin until asked, and keeps a lone one', async () => {
    api.searchSerials.mockResolvedValue({
      query: 'orv',
      hits: [
        hit({ seriesKey: null, url: 'u1', kind: 'novel', title: 'Omniscient Reader’s Viewpoint (Web Novel KR)' }),
        hit({ seriesKey: null, url: 'u2', kind: 'novel', title: 'MTL-Omniscient Reader’s Viewpoint', mtl: true }),
        hit({ seriesKey: null, url: 'u3', kind: 'novel', title: 'MTL-Lonely Tale', mtl: true }),
      ],
      failedSources: [],
    })
    const search = useWebSerialSearch()
    search.query.value = 'orv'
    search.setScope('novel')
    await search.searchSites()
    await flushPromises()

    expect(search.hasMtlHits.value).toBe(true)
    expect(search.visibleHits.value.map((entry) => entry.url)).toEqual(['u1', 'u3'])

    search.setShowMachineTranslations(true)
    expect(search.visibleHits.value.map((entry) => entry.url)).toEqual(['u1', 'u2', 'u3'])
  })
})

describe('useWebSerialSearch preview of a long chapter list', () => {
  const stillLoading = () => new WebSerialApiError('loading', 503, WebSerialErrorCode.SeriesLoading, null, { retryAfterMs: 5000 })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps asking while the server loads, naming the site, then opens the series', async () => {
    api.fetchSeries.mockRejectedValueOnce(stillLoading()).mockResolvedValueOnce(mangaDetail())
    const search = useWebSerialSearch()
    const opening = search.openHit(hit({ sourceName: 'AllManga' }))
    await vi.waitFor(() => expect(search.previewPending.value).toEqual({ source: 'AllManga' }))

    await vi.advanceTimersByTimeAsync(5000)

    await expect(opening).resolves.toMatchObject({ seriesKey: 'm:7' })
    expect(search.previewPending.value).toBeNull()
  })

  it('stops quietly when the preview is cancelled', async () => {
    api.fetchSeries.mockRejectedValue(stillLoading())
    const search = useWebSerialSearch()
    const opening = search.openHit(hit())
    await vi.waitFor(() => expect(search.previewPending.value).not.toBeNull())

    search.cancelPreview()

    await expect(opening).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
    expect(search.previewError.value).toBeNull()
    expect(search.previewPending.value).toBeNull()
  })

  it('gives up after 35 minutes and shows the server message', async () => {
    api.fetchSeries.mockRejectedValue(stillLoading())
    const search = useWebSerialSearch()
    const opening = search.openHit(hit())
    await vi.advanceTimersByTimeAsync(36 * 60_000)
    await expect(opening).resolves.toBeNull()
    expect(api.fetchSeries.mock.calls.length).toBeGreaterThan(400)
    expect(search.previewError.value).toBe('loading')
  })
})
