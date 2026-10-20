import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { WebSerialErrorCode } from '@bookorbit/types'
import type { WebSerialCatalogEntry, WebSerialSourceOptions, WebSerialSuggestion } from '@bookorbit/types'
import { catalogEntry, mangaDetail, novelDetail, suggestion } from './fixtures'

const api = vi.hoisted(() => ({
  fetchDiscoverSources: vi.fn<(...args: unknown[]) => Promise<WebSerialSourceOptions>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import { WebSerialApiError } from '../api/http'
import { matchOfEntry, useWebSerialEntryPreview } from '../composables/useWebSerialEntryPreview'

const option = (seriesKey: string, chapterCount: number, mostComplete = false) => ({
  seriesKey,
  sourceName: `Source ${seriesKey}`,
  title: 'T',
  chapterCount,
  latestAt: null,
  confidence: 'same_series' as const,
  mostComplete,
})

function setup(entry: WebSerialCatalogEntry | null = catalogEntry()) {
  const entryRef = ref<WebSerialCatalogEntry | null>(entry)
  const state = effectScope().run(() => useWebSerialEntryPreview(entryRef))!
  return { entryRef, ...state }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useWebSerialEntryPreview', () => {
  it('looks for the sources, preselects the most complete one and opens it with the match id', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [option('m:9', 300, true), option('m:2', 20)], failedSources: [] })
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))

    const preview = setup()
    expect(preview.state.value).toBe('finding')
    await vi.waitFor(() => expect(preview.state.value).toBe('ready'))

    expect(api.fetchDiscoverSources).toHaveBeenCalledWith('manga', '1995', expect.any(AbortSignal), false)
    expect(api.fetchSeries).toHaveBeenCalledWith('m:9', '1995', expect.any(AbortSignal))
    expect(preview.preselectedKey.value).toBe('m:9')
    expect(preview.detail.value?.seriesKey).toBe('m:9')
  })

  it('retries only the failed sources with a cache bypass', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: ['Slow Site'] })
    const preview = setup()
    await vi.waitFor(() => expect(preview.state.value).toBe('none'))

    await preview.retryFailed()

    expect(api.fetchDiscoverSources).toHaveBeenLastCalledWith('manga', '1995', expect.any(AbortSignal), true)
  })

  it('is "none" when no source has the series and keeps the failed sources', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: ['Slow Site'] })

    const preview = setup()
    await vi.waitFor(() => expect(preview.state.value).toBe('none'))

    expect(preview.failedSources.value).toEqual(['Slow Site'])
    expect(api.fetchSeries).not.toHaveBeenCalled()
    expect(preview.detail.value).toBeNull()
  })

  it('reports a failed source check and retries it', async () => {
    api.fetchDiscoverSources.mockRejectedValueOnce(new Error('boom'))
    const preview = setup()
    await vi.waitFor(() => expect(preview.state.value).toBe('error'))
    expect(preview.error.value).toBe('boom')

    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: [] })
    await preview.retry()
    expect(preview.state.value).toBe('none')
    expect(preview.error.value).toBeNull()
  })

  it('reports a series that fails to open while keeping the options', async () => {
    api.fetchDiscoverSources.mockResolvedValue({ options: [option('m:9', 300, true)], failedSources: [] })
    api.fetchSeries.mockRejectedValue(new Error('source down'))

    const preview = setup()
    await vi.waitFor(() => expect(preview.state.value).toBe('error'))

    expect(preview.options.value).toHaveLength(1)
    expect(preview.error.value).toBe('source down')
  })

  it('drops the answer for an entry that was replaced meanwhile', async () => {
    let finish: (value: WebSerialSourceOptions) => void = () => undefined
    api.fetchDiscoverSources.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const preview = setup()
    api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: [] })

    preview.entryRef.value = catalogEntry({ matchId: '2' })
    await vi.waitFor(() => expect(preview.state.value).toBe('none'))
    finish({ options: [option('m:1', 1)], failedSources: [] })
    await Promise.resolve()

    expect(preview.state.value).toBe('none')
    expect(preview.options.value).toEqual([])
  })
})

describe('useWebSerialEntryPreview chapter counts of a suggestion', () => {
  const copies = ['nl:a:1', 'nl:b:2', 'nl:c:3'].map((seriesKey, index) => ({
    sourceId: String(index),
    sourceName: `Site ${index}`,
    path: `p${index}`,
    mtl: false,
    seriesKey,
  }))

  it('stops counting the other copies when the sheet closes, and picks up where it left off when it opens again', async () => {
    const signals: (AbortSignal | undefined)[] = []
    api.fetchSeries.mockImplementation((...args: unknown[]) => {
      const [seriesKey, , signal] = args as [string, string | undefined, AbortSignal | undefined]
      if (seriesKey === 'nl:a:1') return Promise.resolve(novelDetail({ seriesKey }))
      signals.push(signal)
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        if (!signal) resolve(novelDetail({ seriesKey }))
      })
    })
    const open = ref(true)
    const suggestionRef = ref<WebSerialSuggestion | null>(suggestion({ entries: copies }))
    effectScope().run(() => useWebSerialEntryPreview(ref(null), suggestionRef, open))
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    open.value = false
    await nextTick()
    await Promise.resolve()

    expect(signals[0]!.aborted).toBe(true)
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)

    open.value = true
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(api.fetchSeries).toHaveBeenLastCalledWith('nl:b:2', undefined, expect.any(AbortSignal))
  })
})

describe('matchOfEntry', () => {
  it('turns a search entry into the preset match', () => {
    expect(matchOfEntry(catalogEntry())).toEqual({
      provider: 'mangabaka',
      id: '1995',
      title: 'Frieren: Beyond Journey’s End',
      url: 'https://mangabaka.org/1995',
      year: 2020,
      authors: ['Kanehito Yamada'],
      artists: ['Tsukasa Abe'],
      status: 'ongoing',
      genres: ['Fantasy'],
    })
  })

  it('carries the publication details, so a licensed series keeps its published volumes', () => {
    const publication = { licensed: true, finalVolume: 13, publishers: [{ name: 'VIZ Media', type: 'English', language: 'en' }] }
    expect(matchOfEntry(catalogEntry({ publication })).publication).toEqual(publication)
  })
})

describe('useWebSerialEntryPreview with a long chapter list', () => {
  function stillLoading(): WebSerialApiError {
    return new WebSerialApiError('still loading', 503, WebSerialErrorCode.SeriesLoading, null, { retryAfterMs: 5000 })
  }

  function setupOpen() {
    const entryRef = ref<WebSerialCatalogEntry | null>(catalogEntry())
    const open = ref(true)
    const scope = effectScope()
    const state = scope.run(() => useWebSerialEntryPreview(entryRef, undefined, open))!
    return { entryRef, open, scope, ...state }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    api.fetchDiscoverSources.mockResolvedValue({ options: [option('m:9', 300, true)], failedSources: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the site while it waits and asks again after the delay the server gave', async () => {
    api.fetchSeries.mockRejectedValueOnce(stillLoading()).mockResolvedValueOnce(mangaDetail({ seriesKey: 'm:9' }))
    const preview = setupOpen()
    await vi.waitFor(() => expect(preview.pendingSource.value).toBe('Source m:9'))
    expect(preview.state.value).toBe('opening')

    await vi.advanceTimersByTimeAsync(5000)

    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
    expect(preview.state.value).toBe('ready')
    expect(preview.pendingSource.value).toBeNull()
  })

  it('stops asking when the sheet closes and asks again when it reopens', async () => {
    api.fetchSeries.mockRejectedValue(stillLoading())
    const preview = setupOpen()
    await vi.waitFor(() => expect(preview.pendingSource.value).toBe('Source m:9'))

    preview.open.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
    expect(preview.state.value).toBe('error')
    expect(preview.error.value).toBeNull()

    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))
    preview.open.value = true
    await preview.refreshIfStale(60_000)
    expect(preview.state.value).toBe('ready')
  })

  it('drops a load closed while its sources were still being found, and reopening starts a fresh one', async () => {
    let found: (value: WebSerialSourceOptions) => void = () => undefined
    api.fetchDiscoverSources.mockReturnValueOnce(new Promise((resolve) => (found = resolve)))
    api.fetchSeries.mockRejectedValue(stillLoading())
    const preview = setupOpen()
    expect(preview.state.value).toBe('finding')

    preview.open.value = false
    await nextTick()
    found({ options: [option('m:9', 300, true)], failedSources: [] })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(api.fetchSeries).not.toHaveBeenCalled()
    expect(preview.state.value).toBe('error')
    expect(preview.pendingSource.value).toBeNull()

    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))
    preview.open.value = true
    await preview.refreshIfStale(60_000)
    expect(api.fetchDiscoverSources).toHaveBeenCalledTimes(2)
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
    expect(preview.state.value).toBe('ready')
  })

  it('does not load a series picked while the sheet is closed until it opens', async () => {
    const preview = setupOpen()
    await vi.waitFor(() => expect(preview.state.value).not.toBe('finding'))
    preview.open.value = false
    await nextTick()
    api.fetchDiscoverSources.mockClear()

    preview.entryRef.value = catalogEntry({ matchId: '2' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchDiscoverSources).not.toHaveBeenCalled()
    expect(preview.state.value).toBe('idle')

    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))
    preview.open.value = true
    await preview.refreshIfStale(60_000)
    expect(api.fetchDiscoverSources).toHaveBeenCalledWith('manga', '2', expect.any(AbortSignal), false)
  })

  it('stops asking when the preview is unmounted', async () => {
    api.fetchSeries.mockRejectedValue(stillLoading())
    const preview = setupOpen()
    await vi.waitFor(() => expect(preview.pendingSource.value).toBe('Source m:9'))
    preview.scope.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
  })

  it('reloads a reopened series only once its answer is older than the limit', async () => {
    api.fetchSeries.mockResolvedValue(mangaDetail({ seriesKey: 'm:9' }))
    const preview = setupOpen()
    await vi.waitFor(() => expect(preview.state.value).toBe('ready'))
    expect(preview.refreshIfStale(60_000)).toBeNull()

    await vi.advanceTimersByTimeAsync(61_000)
    await preview.refreshIfStale(60_000)

    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
  })
})

it('opening the web sources disclosure starts the source lookup once', async () => {
  api.fetchDiscoverSources.mockResolvedValue({ options: [], failedSources: [] })
  const deferred = ref(true)
  const scope = effectScope()
  const preview = scope.run(() => useWebSerialEntryPreview(ref(catalogEntry()), undefined, ref(true), deferred))!
  expect(preview.state.value).toBe('idle')
  expect(api.fetchDiscoverSources).not.toHaveBeenCalled()
  deferred.value = false
  await nextTick()
  expect(api.fetchDiscoverSources).toHaveBeenCalledTimes(1)
  scope.stop()
})
