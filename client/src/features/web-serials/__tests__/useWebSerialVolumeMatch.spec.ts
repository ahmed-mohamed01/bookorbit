import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, type Ref } from 'vue'
import type { MetadataCandidate, MetadataProviderInfo } from '@bookorbit/types'

const search = vi.hoisted(() => ({
  loadProviders: vi.fn<() => Promise<void>>(),
  run: vi.fn<(params: Record<string, unknown>) => Promise<void>>(),
  results: undefined as unknown as Ref<MetadataCandidate[]>,
  providers: undefined as unknown as Ref<MetadataProviderInfo[]>,
}))

vi.mock('@/features/book/composables/useMetadataSearch', async () => {
  const { ref } = await import('vue')
  search.results = ref<MetadataCandidate[]>([])
  search.providers = ref<MetadataProviderInfo[]>([])
  return {
    useMetadataSearch: () => ({
      results: search.results,
      providers: search.providers,
      loadProviders: search.loadProviders,
      search: search.run,
    }),
  }
})

import { useWebSerialVolumeMatch, VOLUME_QUERY_TIMEOUT_MS } from '../composables/useWebSerialVolumeMatch'
import { MAX_VOLUME_SEARCH_QUERIES } from '../lib/publishedVolumeMatch'
import type { PublishedSeries } from '../lib/publishedVolumes'

function candidate(overrides: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    provider: 'google',
    providerId: 'g1',
    displayTitle: 'The Water Magician: Volume 2',
    authors: ['Tadashi Kubou'],
    language: 'en',
    seriesIndex: '2',
    ...overrides,
  }
}

function series(overrides: Partial<PublishedSeries> = {}): PublishedSeries {
  return {
    kind: 'novel',
    matchId: '9102',
    title: 'The Water Magician: The Central Provinces Arc',
    authors: ['Kubou Tadashi'],
    url: 'https://mangabaka.org/9102',
    publication: { licensed: true, finalVolume: 2, publishers: [] },
    ...overrides,
  }
}

/** Feeds each query its own results, the way the provider stream would. */
function answerByQuery(byTitle: Record<string, MetadataCandidate[]>): void {
  search.run.mockImplementation(async (params) => {
    search.results.value = byTitle[params.title as string] ?? []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  search.loadProviders.mockResolvedValue(undefined)
  search.results.value = []
  search.providers.value = [{ key: 'google', label: 'Google Books', identifiable: true }]
})

describe('useWebSerialVolumeMatch resolveVolume', () => {
  it('searches the full title first, then the one without the subtitle', async () => {
    answerByQuery({ 'The Water Magician Vol. 2': [candidate()] })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    const pick = await match.resolveVolume(series(), 2)

    expect(search.run.mock.calls.map(([params]) => params.title)).toEqual([
      'The Water Magician: The Central Provinces Arc Vol. 2',
      'The Water Magician Vol. 2',
    ])
    expect(search.run.mock.calls.every(([params]) => params.mediaKind === 'ebook' && params.author === 'Kubou Tadashi')).toBe(true)
    expect(pick?.candidate.providerId).toBe('g1')
  })

  it('stops at the first query whose results hold the volume', async () => {
    answerByQuery({ 'The Water Magician: The Central Provinces Arc Vol. 2': [candidate()] })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    await match.resolveVolume(series(), 2)

    expect(search.run).toHaveBeenCalledTimes(1)
  })

  it('tries every query, and never more than the cap, when nothing matches', async () => {
    answerByQuery({})
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    await expect(match.resolveVolume(series(), 2)).resolves.toBeNull()

    const calls = search.run.mock.calls.length
    expect(calls).toBe(2)
    expect(calls).toBeLessThanOrEqual(MAX_VOLUME_SEARCH_QUERIES)
  })

  it('keeps a volume the second query finds even though the first found nothing', async () => {
    answerByQuery({ 'The Water Magician Vol. 2': [candidate({ providerId: 'g2' })] })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    const pick = await match.resolveVolume(series(), 2)

    expect(pick?.candidate.providerId).toBe('g2')
    expect(search.run).toHaveBeenCalledTimes(2)
  })

  it('asks for the providers once across volumes', async () => {
    answerByQuery({ 'The Water Magician Vol. 1': [candidate({ seriesIndex: '1', displayTitle: 'The Water Magician: Volume 1' })] })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    await match.resolveVolume(series(), 1)
    await match.resolveVolume(series(), 1)

    expect(search.loadProviders).toHaveBeenCalledTimes(1)
  })

  it('lets two volumes matched at once each find their own book', async () => {
    const byTitle: Record<string, MetadataCandidate[]> = {
      'The Water Magician: The Central Provinces Arc Vol. 1': [
        candidate({ providerId: 'v1', seriesIndex: '1', displayTitle: 'The Water Magician: Volume 1' }),
      ],
      'The Water Magician: The Central Provinces Arc Vol. 2': [candidate({ providerId: 'v2' })],
    }
    let latest = 0
    search.run.mockImplementation(async (params) => {
      const call = ++latest
      search.results.value = []
      await new Promise((resolve) => setTimeout(resolve, String(params.title).endsWith('1') ? 30 : 5))
      if (call !== latest) return
      search.results.value = byTitle[params.title as string] ?? []
    })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    const [one, two] = await Promise.all([match.resolveVolume(series(), 1), match.resolveVolume(series(), 2)])

    expect(one?.candidate.providerId).toBe('v1')
    expect(two?.candidate.providerId).toBe('v2')
  })
})

describe('useWebSerialVolumeMatch failure and lifetime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for the providers again after a failed load instead of failing every later volume', async () => {
    answerByQuery({ 'The Water Magician Vol. 2': [candidate()] })
    search.loadProviders.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    await expect(match.resolveVolume(series(), 2)).rejects.toThrow('Failed to fetch')
    const pick = await match.resolveVolume(series(), 2)

    expect(search.loadProviders).toHaveBeenCalledTimes(2)
    expect(pick?.candidate.providerId).toBe('g1')
  })

  it('cuts off a query that never finishes and goes on with what arrived', async () => {
    vi.useFakeTimers()
    search.run.mockImplementationOnce(() => {
      search.results.value = []
      return new Promise<void>(() => {})
    })
    search.run.mockImplementationOnce(async () => {
      search.results.value = [candidate({ providerId: 'late' })]
    })
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    const pending = match.resolveVolume(series(), 2)
    await vi.advanceTimersByTimeAsync(VOLUME_QUERY_TIMEOUT_MS - 1)
    expect(search.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({ candidate: { providerId: 'late' } })
    expect(search.run).toHaveBeenCalledTimes(2)
  })

  it('does not search for volumes still queued when the page goes away', async () => {
    let release!: () => void
    search.run.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const scope = effectScope()
    const match = scope.run(() => useWebSerialVolumeMatch())!

    const first = match.resolveVolume(series(), 1)
    const second = match.resolveVolume(series(), 2)
    await vi.waitFor(() => expect(search.run).toHaveBeenCalledTimes(1))
    scope.stop()
    release()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(search.run).toHaveBeenCalledTimes(1)
  })
})

describe('useWebSerialVolumeMatch providerLabel', () => {
  it('names a provider the way the Requests page does, falling back to its key', () => {
    const match = effectScope().run(() => useWebSerialVolumeMatch())!

    expect(match.providerLabel('google')).toBe('Google Books')
    expect(match.providerLabel('openLibrary')).toBe('openLibrary')
  })
})
