import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { catalogEntry, hit } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(key: string) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import { useWebSerialSearch } from '../composables/useWebSerialSearch'

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.searchSerials.mockResolvedValue({ query: 'frieren', hits: [hit({ title: 'Frieren (site)' })], failedSources: [] })
})

async function searched(query = 'frieren') {
  const search = useWebSerialSearch()
  await search.loadCapabilities()
  search.query.value = query
  await search.submit()
  return search
}

describe('useWebSerialSearch series database first', () => {
  it('searches the series database and never the sources for a title', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry(), catalogEntry({ matchId: '2', title: 'Another' })], fallback: null })

    const search = await searched()

    expect(api.discoverSerials).toHaveBeenCalledWith('frieren', 'all', expect.any(AbortSignal), false)
    expect(api.searchSerials).not.toHaveBeenCalled()
    expect(search.mode.value).toBe('series')
    expect(search.entries.value).toHaveLength(2)
    expect(search.fallbackReason.value).toBeNull()
    expect(search.hasSearched.value).toBe(true)
    expect(search.searching.value).toBe(false)
  })

  it('asks for the one kind in scope, and for all only when both are searchable', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const search = useWebSerialSearch()
    await search.loadCapabilities()
    search.query.value = 'frieren'
    search.setScope('novel')
    await search.submit()
    expect(api.discoverSerials).toHaveBeenLastCalledWith('frieren', 'novel', expect.any(AbortSignal), false)

    api.fetchCapabilities.mockResolvedValue({ ...BOTH, novel: { ...BOTH.novel, searchable: false } })
    const mangaOnly = useWebSerialSearch()
    await mangaOnly.loadCapabilities()
    mangaOnly.query.value = 'frieren'
    await mangaOnly.submit()
    expect(api.discoverSerials).toHaveBeenLastCalledWith('frieren', 'manga', expect.any(AbortSignal), false)
  })

  it('sorts by the database order, or by title', async () => {
    api.discoverSerials.mockResolvedValue({
      results: [catalogEntry({ matchId: '1', title: 'Zebra' }), catalogEntry({ matchId: '2', title: 'Apple' })],
      fallback: null,
    })
    const search = await searched()

    expect(search.visibleEntries.value.map((entry) => entry.title)).toEqual(['Zebra', 'Apple'])
    search.setResultSort('title')
    expect(search.visibleEntries.value.map((entry) => entry.title)).toEqual(['Apple', 'Zebra'])
    search.setResultSort('source')
    expect(search.catalogSort.value).toBe('relevance')
    expect(search.visibleEntries.value.map((entry) => entry.title)).toEqual(['Zebra', 'Apple'])
  })

  it.each(['disabled', 'unavailable', 'empty'] as const)(
    'runs the source search and keeps the reason when the database answers "%s"',
    async (reason) => {
      api.discoverSerials.mockResolvedValue({ results: [], fallback: reason })

      const search = await searched()

      expect(api.searchSerials).toHaveBeenCalledTimes(2)
      expect(search.mode.value).toBe('sites')
      expect(search.fallbackReason.value).toBe(reason)
      expect(search.hits.value.length).toBeGreaterThan(0)
      expect(search.canReturnToSeries.value).toBe(false)
    },
  )

  it('treats a failed database request as unavailable and still shows source results', async () => {
    api.discoverSerials.mockRejectedValue(new Error('500'))

    const search = await searched()

    expect(search.fallbackReason.value).toBe('unavailable')
    expect(search.mode.value).toBe('sites')
    expect(search.hits.value.length).toBeGreaterThan(0)
  })

  it('searches the sites directly on request, keeps the series results and goes back to them', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const search = await searched()

    await search.searchSites()

    expect(search.mode.value).toBe('sites')
    expect(search.fallbackReason.value).toBeNull()
    expect(api.searchSerials).toHaveBeenCalledWith('frieren', expect.any(String), expect.any(AbortSignal), false)
    expect(search.canReturnToSeries.value).toBe(true)

    search.backToSeries()

    expect(search.mode.value).toBe('series')
    expect(search.entries.value).toHaveLength(1)
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
  })

  it('prefills the sites search with a title from the preview', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const search = await searched()

    await search.searchSites('Sousou no Frieren')

    expect(search.query.value).toBe('Sousou no Frieren')
    expect(api.searchSerials).toHaveBeenCalledWith('Sousou no Frieren', expect.any(String), expect.any(AbortSignal), false)
  })

  it('a new title search returns to the series list', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const search = await searched()
    await search.searchSites()

    search.query.value = 'frieren again'
    await search.submit()

    expect(search.mode.value).toBe('series')
    expect(api.discoverSerials).toHaveBeenCalledTimes(2)
  })

  it('does not touch the series database for a pasted link', async () => {
    api.resolveSerialUrl.mockResolvedValue({ seriesKey: 'n:3' })
    const search = useWebSerialSearch()
    search.query.value = 'https://www.royalroad.com/fiction/1/x'

    await expect(search.submit()).resolves.toMatchObject({ seriesKey: 'n:3' })
    expect(api.discoverSerials).not.toHaveBeenCalled()
  })
})
