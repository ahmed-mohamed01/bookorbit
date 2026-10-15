import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { BookRequestItem, BookRequestStatus, MetadataCandidate, ReleaseCandidateItem } from '@bookorbit/types'
import type { VolumeCandidatePick } from '../lib/publishedVolumeMatch'
import type { PublishedSeries } from '../lib/publishedVolumes'

const api = vi.hoisted(() => ({
  fetchRequestSourceStatus: vi.fn<() => Promise<{ configured: number; enabled: number }>>(),
  fetchPublishedRequests: vi.fn<(kind: string, matchId: string) => Promise<{ volume: string; bookRequestId: number }[]>>(),
  fetchBookRequest: vi.fn<(id: number) => Promise<BookRequestItem | null>>(),
  recordPublishedRequest: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  createVolumeRequest: vi.fn<(payload: Record<string, unknown>) => Promise<{ request: BookRequestItem; subscribed: boolean }>>(),
  cancelVolumeRequest: vi.fn<(id: number) => Promise<BookRequestItem>>(),
  fetchRequestReleases: vi.fn<(id: number) => Promise<{ releases: ReleaseCandidateItem[] }>>(),
  grabRequestRelease: vi.fn<(id: number, indexerId: number, guid: string) => Promise<BookRequestItem>>(),
}))
const serials = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<unknown>>(),
}))
const match = vi.hoisted(() => ({
  resolveVolume: vi.fn<(series: PublishedSeries, volume: number) => Promise<VolumeCandidatePick | null>>(),
  providerLabel: vi.fn<(provider: string) => string>((provider) => provider),
}))

vi.mock('../api/bookRequests', () => api)
vi.mock('../api/webSerials', () => serials)
vi.mock('../composables/useWebSerialVolumeMatch', () => ({ useWebSerialVolumeMatch: () => match }))
vi.mock('@/features/book-requests/composables/useRequestDestinationDefault', () => ({
  useRequestLanguageDefault: () => ({ load: vi.fn<() => Promise<boolean>>().mockResolvedValue(true), resolveLanguage: () => 'en' }),
}))
vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref: vueRef } = await import('vue')
  const libraries = vueRef([{ id: 4, allowedFormats: ['cbz'] }])
  return { useLibraries: () => ({ libraries, fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }) }
})

import { INLINE_RELEASE_LIMIT, useWebSerialPublishedVolumes } from '../composables/useWebSerialPublishedVolumes'

/** Seeds the recorded ids for the series and the per-id status reads behind them. */
function seedRequests(items: BookRequestItem[]) {
  api.fetchPublishedRequests.mockResolvedValue(items.map((entry) => ({ volume: String(entry.seriesIndex), bookRequestId: entry.id })))
  api.fetchBookRequest.mockImplementation((id) => Promise.resolve(items.find((entry) => entry.id === id) ?? null))
}

function item(id: number, seriesIndex: number, status: BookRequestStatus = 'pending'): BookRequestItem {
  return { id, userId: 7, seriesIndex, seriesName: 'Spice and Wolf', mediaKind: 'ebook', status } as BookRequestItem
}

/** A request the old free-text path would have made: no provider record or ISBN behind it. */
function freeTextItem(id: number, seriesIndex: number, status: BookRequestStatus = 'pending'): BookRequestItem {
  return { ...item(id, seriesIndex, status), providerId: null, providerKey: null, isbn13: null, isbn10: null }
}

function matchedItem(id: number, seriesIndex: number, status: BookRequestStatus = 'pending'): BookRequestItem {
  return { ...item(id, seriesIndex, status), providerId: `g${seriesIndex}`, providerKey: 'google', isbn13: null, isbn10: null }
}

function release(guid: string): ReleaseCandidateItem {
  return { indexerId: 2, indexerName: 'Tracker', guid, title: `Release ${guid}`, sizeBytes: 1024, seeders: 3 } as ReleaseCandidateItem
}

function series(overrides: Partial<PublishedSeries> = {}): PublishedSeries {
  return {
    kind: 'manga',
    matchId: '1234',
    title: 'Spice and Wolf',
    authors: ['Isuna Hasekura'],
    url: 'https://mangabaka.org/1234',
    publication: { licensed: true, finalVolume: 3, publishers: [] },
    ...overrides,
  }
}

/** The volume's real book, as the provider search would hand it back. */
function pick(volume: number): VolumeCandidatePick {
  const candidate = {
    provider: 'google',
    providerId: `g${volume}`,
    displayTitle: `Spice and Wolf: Volume ${volume}`,
    authors: ['Isuna Hasekura'],
    language: 'en',
    seriesIndex: String(volume),
  } as MetadataCandidate
  return { candidate, score: 78, accepted: [candidate] }
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(options: { canRequest?: boolean; canManage?: boolean; offered?: boolean; value?: PublishedSeries } = {}) {
  const seriesRef = ref<PublishedSeries | null>(options.value ?? series())
  const access = {
    canRequest: ref(options.canRequest ?? true),
    canManage: ref(options.canManage ?? false),
    offered: ref(options.offered ?? true),
    userId: ref<number | null>(7),
  }
  const state = effectScope().run(() => useWebSerialPublishedVolumes(seriesRef, access))!
  return { seriesRef, access, ...state }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchRequestSourceStatus.mockResolvedValue({ configured: 1, enabled: 1 })
  seedRequests([])
  api.recordPublishedRequest.mockResolvedValue(undefined)
  match.resolveVolume.mockResolvedValue(null)
  api.cancelVolumeRequest.mockImplementation((id) => Promise.resolve({ ...item(id, 1), status: 'cancelled' }))
  serials.fetchCapabilities.mockResolvedValue({
    manga: { available: true, searchable: true, defaultLibraryId: 4, targetFolderId: null },
    novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: 5, targetFolderId: 6 },
  })
})

describe('useWebSerialPublishedVolumes visibility', () => {
  it('shows when offered, permitted and Book Requests has an enabled source', async () => {
    const state = setup()
    await flush()
    expect(state.visible.value).toBe(true)
    expect(api.fetchPublishedRequests).toHaveBeenCalledWith('manga', '1234')
  })

  it('stays hidden and asks nothing without the request permission', async () => {
    const state = setup({ canRequest: false })
    await flush()
    expect(state.visible.value).toBe(false)
    expect(api.fetchRequestSourceStatus).not.toHaveBeenCalled()
    expect(api.fetchPublishedRequests).not.toHaveBeenCalled()
  })

  it('stays hidden and asks nothing when the series is neither licensed nor unavailable', async () => {
    const state = setup({ offered: false })
    await flush()
    expect(state.visible.value).toBe(false)
    expect(api.fetchRequestSourceStatus).not.toHaveBeenCalled()
  })

  it('stays hidden when Book Requests has no enabled source, or the check fails', async () => {
    api.fetchRequestSourceStatus.mockResolvedValueOnce({ configured: 2, enabled: 0 })
    const off = setup()
    await flush()
    expect(off.visible.value).toBe(false)
    expect(api.fetchPublishedRequests).not.toHaveBeenCalled()

    api.fetchRequestSourceStatus.mockRejectedValueOnce(new Error('down'))
    const failed = setup()
    await flush()
    expect(failed.visible.value).toBe(false)
  })
})

describe('useWebSerialPublishedVolumes volumes', () => {
  it('lists the final volume count from the series database with each request status', async () => {
    seedRequests([matchedItem(11, 2, 'downloading')])
    const state = setup()
    await flush()
    expect(state.knownCount.value).toBe(3)
    expect(state.rows.value.map((row) => [row.volume, row.request?.status ?? null])).toEqual([
      [1, null],
      [2, 'downloading'],
      [3, null],
    ])
    expect(state.missing.value.map((row) => row.volume)).toEqual([1, 3])
  })

  it('uses the typed count when the final volume is unknown', async () => {
    const state = setup({ value: series({ publication: { licensed: true, finalVolume: null, publishers: [] } }) })
    await flush()
    expect(state.rows.value).toEqual([])
    state.setTypedCount(5)
    expect(state.rows.value).toHaveLength(5)
    state.setTypedCount(5000)
    expect(state.rows.value).toHaveLength(200)
    state.setTypedCount(0)
    expect(state.rows.value).toEqual([])
  })

  it('resolves the volume to a published book and requests that book', async () => {
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(21, 1, 'approved'), subscribed: false })
    match.resolveVolume.mockResolvedValue(pick(1))
    const state = setup()
    await flush()

    await expect(state.requestVolume(1)).resolves.toBe(true)

    expect(match.resolveVolume).toHaveBeenCalledWith(expect.objectContaining({ title: 'Spice and Wolf' }), 1)
    expect(api.createVolumeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Spice and Wolf: Volume 1',
        providerKey: 'google',
        providerId: 'g1',
        seriesIndex: 1,
        language: 'en',
        targetLibraryId: 4,
        preferredFormats: ['cbz'],
      }),
    )
    expect(state.rows.value[0]!.request?.id).toBe(21)
    expect(state.matches.value[1]).toEqual({ state: 'matched', title: 'Spice and Wolf: Volume 1' })
  })

  it('does not request a guess when no published book matches the volume', async () => {
    const state = setup()
    await flush()

    await expect(state.requestVolume(1)).resolves.toBe(false)

    expect(api.createVolumeRequest).not.toHaveBeenCalled()
    expect(state.matches.value[1]).toEqual({ state: 'none' })
  })

  it('keeps the free-text request for a volume the requester asks for anyway', async () => {
    api.createVolumeRequest.mockResolvedValue({ request: item(22, 1, 'pending'), subscribed: false })
    const state = setup()
    await flush()
    state.matches.value = { 1: { state: 'none' } }

    await expect(state.requestVolumeAnyway(1)).resolves.toBe(true)

    expect(api.createVolumeRequest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Spice and Wolf Vol. 1', seriesIndex: 1 }))
    expect(state.rows.value[0]!.request?.id).toBe(22)
    expect(state.matches.value).toEqual({})
  })

  it('reports a failed search rather than pretending the volume has no book', async () => {
    match.resolveVolume.mockRejectedValue(new Error('Providers did not answer'))
    const state = setup()
    await flush()

    await expect(state.requestVolume(1)).resolves.toBe(false)

    expect(state.errors.value[1]).toBe('Providers did not answer')
    expect(state.matches.value).toEqual({})
  })

  it('requests every missing volume one at a time, in order, and keeps going past a refusal', async () => {
    seedRequests([item(11, 2)])
    match.resolveVolume.mockImplementation(async (_current, volume) => pick(volume))
    const order: number[] = []
    let inFlight = 0
    api.createVolumeRequest.mockImplementation(async (payload) => {
      inFlight += 1
      expect(inFlight).toBe(1)
      const volume = payload.seriesIndex as number
      order.push(volume)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      if (volume === 1) throw new Error('Your self-serve limit is full')
      return { request: item(30 + volume, volume), subscribed: false }
    })
    const state = setup()
    await flush()

    const run = state.requestAllMissing()
    expect(state.bulk.value).toEqual({ done: 0, total: 2 })
    await run

    expect(order).toEqual([1, 3])
    expect(state.bulk.value).toBeNull()
    expect(state.errors.value).toEqual({ 1: 'Your self-serve limit is full' })
    expect(state.rows.value.map((row) => row.request?.id ?? null)).toEqual([null, 11, 33])
  })

  it('skips a volume without a published match when requesting every missing one', async () => {
    match.resolveVolume.mockImplementation(async (_current, volume) => (volume === 2 ? pick(2) : null))
    api.createVolumeRequest.mockResolvedValue({ request: item(32, 2, 'pending'), subscribed: false })
    const state = setup({ value: series({ publication: { licensed: true, finalVolume: 2, publishers: [] } }) })
    await flush()

    await state.requestAllMissing()

    expect(api.createVolumeRequest).toHaveBeenCalledTimes(1)
    expect(state.matches.value).toEqual({ 1: { state: 'none' }, 2: { state: 'matched', title: 'Spice and Wolf: Volume 2' } })
  })

  it('skips a volume in a bulk run that was requested another way since the run started', async () => {
    match.resolveVolume.mockImplementation(async (_current, volume) => pick(volume))
    api.createVolumeRequest.mockImplementation(async (payload) => ({
      request: item(40 + (payload.seriesIndex as number), payload.seriesIndex as number),
      subscribed: false,
    }))
    const state = setup({ value: series({ publication: { licensed: true, finalVolume: 2, publishers: [] } }) })
    await flush()

    const run = state.requestAllMissing()
    await state.requestVolumeAnyway(2)
    await run

    expect(api.createVolumeRequest.mock.calls.map(([payload]) => payload.seriesIndex)).toEqual([2, 1])
  })

  it('stops a bulk run when the section goes away', async () => {
    let release: () => void = () => undefined
    match.resolveVolume.mockImplementation((_current, volume) => new Promise((resolve) => (release = () => resolve(pick(volume)))))
    const seriesRef = ref<PublishedSeries | null>(series())
    const scope = effectScope()
    const state = scope.run(() =>
      useWebSerialPublishedVolumes(seriesRef, { canRequest: ref(true), canManage: ref(false), offered: ref(true), userId: ref<number | null>(7) }),
    )!
    await flush()

    const run = state.requestAllMissing()
    await flush()
    scope.stop()
    release()
    await run

    expect(match.resolveVolume).toHaveBeenCalledTimes(1)
    expect(api.createVolumeRequest).not.toHaveBeenCalled()
  })

  it('reloads for another series and drops the old answers', async () => {
    seedRequests([item(11, 1)])
    const state = setup()
    await flush()
    expect(state.rows.value[0]!.request?.id).toBe(11)

    seedRequests([])
    state.seriesRef.value = series({ title: 'Wolf and Parchment', matchId: '77' })
    await flush()
    expect(api.fetchPublishedRequests).toHaveBeenLastCalledWith('manga', '77')
    expect(state.rows.value[0]!.request).toBeNull()
    expect(state.matches.value).toEqual({})
  })
})

describe('useWebSerialPublishedVolumes recorded requests', () => {
  it('records the Book Request id after a successful create', async () => {
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(21, 1, 'approved'), subscribed: false })
    match.resolveVolume.mockResolvedValue(pick(1))
    const state = setup()
    await flush()

    await state.requestVolume(1)

    expect(api.recordPublishedRequest).toHaveBeenCalledWith({ kind: 'manga', matchId: '1234', volume: '1', bookRequestId: 21 })
  })

  it('records the id Book Requests returns when the request joined an existing one', async () => {
    api.createVolumeRequest.mockResolvedValue({ request: item(5, 1, 'pending'), subscribed: true })
    match.resolveVolume.mockResolvedValue(pick(1))
    const state = setup()
    await flush()

    await state.requestVolume(1)

    expect(api.recordPublishedRequest).toHaveBeenCalledWith(expect.objectContaining({ volume: '1', bookRequestId: 5 }))
  })

  it('records nothing when the create is refused, and keeps the request when recording fails', async () => {
    match.resolveVolume.mockResolvedValue(pick(1))
    api.createVolumeRequest.mockRejectedValueOnce(new Error('refused'))
    const state = setup()
    await flush()
    await state.requestVolume(1)
    expect(api.recordPublishedRequest).not.toHaveBeenCalled()

    api.createVolumeRequest.mockResolvedValueOnce({ request: item(22, 2, 'pending'), subscribed: false })
    match.resolveVolume.mockResolvedValueOnce(pick(2))
    api.recordPublishedRequest.mockRejectedValueOnce(new Error('down'))
    await expect(state.requestVolume(2)).resolves.toBe(true)
    expect(state.rows.value[1]!.request?.id).toBe(22)
  })

  it('reads each recorded status with its own fetch and treats a missing or forbidden one as not requested', async () => {
    api.fetchPublishedRequests.mockResolvedValue([
      { volume: '1', bookRequestId: 11 },
      { volume: '2', bookRequestId: 12 },
      { volume: '3', bookRequestId: 13 },
    ])
    api.fetchBookRequest.mockImplementation((id) => Promise.resolve(id === 11 ? matchedItem(11, 1, 'available') : null))
    const state = setup()
    await flush()

    expect(api.fetchBookRequest).toHaveBeenCalledTimes(3)
    expect(state.rows.value.map((row) => row.request?.id ?? null)).toEqual([11, null, null])
    expect(state.missing.value.map((row) => row.volume)).toEqual([2, 3])
  })

  it('never has more than four status reads in flight', async () => {
    api.fetchPublishedRequests.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ volume: String(index + 1), bookRequestId: index + 1 })))
    let inFlight = 0
    let peak = 0
    api.fetchBookRequest.mockImplementation(async (id) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return item(id, id, 'pending')
    })
    setup({ value: series({ publication: { licensed: true, finalVolume: 10, publishers: [] } }) })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(api.fetchBookRequest).toHaveBeenCalledTimes(10)
    expect(peak).toBe(4)
  })

  it('surfaces a failed status read instead of showing a wrong state', async () => {
    api.fetchPublishedRequests.mockResolvedValue([{ volume: '1', bookRequestId: 11 }])
    api.fetchBookRequest.mockRejectedValue(new Error('server error'))
    const state = setup()
    await flush()
    expect(state.listState.value).toBe('error')
  })
})

describe('useWebSerialPublishedVolumes re-match', () => {
  it('holds the matched book for a confirm before replacing a free-text request', async () => {
    seedRequests([freeTextItem(11, 2)])
    match.resolveVolume.mockResolvedValue(pick(2))
    const state = setup()
    await flush()

    await state.rematchVolume(2)

    expect(state.rematch.value).toMatchObject({ volume: 2, title: 'Spice and Wolf: Volume 2' })
    expect(api.cancelVolumeRequest).not.toHaveBeenCalled()
    expect(api.createVolumeRequest).not.toHaveBeenCalled()
    expect(state.matches.value[2]).toEqual({ state: 'matched', title: 'Spice and Wolf: Volume 2' })
  })

  it('cancels the free-text request and asks for the matched book once confirmed', async () => {
    seedRequests([freeTextItem(11, 2)])
    api.cancelVolumeRequest.mockResolvedValue({ ...freeTextItem(11, 2), status: 'cancelled' })
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(31, 2, 'pending'), subscribed: false })
    match.resolveVolume.mockResolvedValue(pick(2))
    const state = setup()
    await flush()
    await state.rematchVolume(2)

    await state.confirmRematch()

    expect(api.cancelVolumeRequest).toHaveBeenCalledWith(11)
    expect(api.createVolumeRequest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Spice and Wolf: Volume 2', providerId: 'g2' }))
    expect(api.recordPublishedRequest).toHaveBeenCalledWith({ kind: 'manga', matchId: '1234', volume: '2', bookRequestId: 31 })
    expect(state.rows.value[1]!.request?.id).toBe(31)
    expect(state.rematch.value).toBeNull()
  })

  it('leaves the request alone when the volume has no published match', async () => {
    seedRequests([freeTextItem(11, 2)])
    const state = setup()
    await flush()

    await state.rematchVolume(2)

    expect(state.rematch.value).toBeNull()
    expect(state.matches.value[2]).toEqual({ state: 'none' })
    expect(api.cancelVolumeRequest).not.toHaveBeenCalled()
    expect(state.rows.value[1]!.request?.id).toBe(11)
  })

  it('offers no re-match on a request the caller cannot cancel', async () => {
    seedRequests([freeTextItem(11, 1, 'available'), { ...freeTextItem(12, 2), userId: 8 }])
    match.resolveVolume.mockResolvedValue(pick(1))
    const state = setup()
    await flush()

    await state.rematchVolume(1)
    await state.rematchVolume(2)

    expect(match.resolveVolume).not.toHaveBeenCalled()
    expect(state.canRematch(state.rows.value[0]!.request)).toBe(false)
    expect(state.canRematch(state.rows.value[1]!.request)).toBe(false)
  })

  it('offers no re-match to a request a provider record was already made from', async () => {
    seedRequests([matchedItem(11, 2)])
    const state = setup()
    await flush()

    await state.rematchVolume(2)

    expect(match.resolveVolume).not.toHaveBeenCalled()
    expect(state.rematch.value).toBeNull()
  })

  it('drops a held confirm without touching the request when it is cancelled', async () => {
    seedRequests([freeTextItem(11, 2)])
    match.resolveVolume.mockResolvedValue(pick(2))
    const state = setup()
    await flush()
    await state.rematchVolume(2)

    state.cancelRematch()

    expect(state.rematch.value).toBeNull()
    expect(api.cancelVolumeRequest).not.toHaveBeenCalled()
  })

  it('keeps the cancelled row honest when the replacement is refused', async () => {
    seedRequests([freeTextItem(11, 2)])
    api.cancelVolumeRequest.mockResolvedValue({ ...freeTextItem(11, 2), status: 'cancelled' })
    api.createVolumeRequest.mockRejectedValue(new Error('Your self-serve limit is full'))
    match.resolveVolume.mockResolvedValue(pick(2))
    const state = setup()
    await flush()
    await state.rematchVolume(2)

    await state.confirmRematch()

    expect(state.rows.value[1]!.request?.status).toBe('cancelled')
    expect(state.errors.value[2]).toBe('Your self-serve limit is full')
    expect(state.rematch.value).toBeNull()
  })
})

describe('useWebSerialPublishedVolumes releases', () => {
  it('offers release search only to managers, on a request that can be grabbed', async () => {
    const plain = setup()
    await flush()
    expect(plain.canFindReleases(matchedItem(1, 1, 'approved'))).toBe(false)

    const manager = setup({ canManage: true })
    await flush()
    expect(manager.canFindReleases(matchedItem(1, 1, 'approved'))).toBe(true)
    expect(manager.canFindReleases(matchedItem(1, 1, 'failed'))).toBe(true)
    expect(manager.canFindReleases(matchedItem(1, 1, 'pending'))).toBe(false)
    expect(manager.canFindReleases(matchedItem(1, 1, 'downloading'))).toBe(false)
    expect(manager.canFindReleases(null)).toBe(false)
  })

  it('searches, keeps the best few, and grabs one through the existing routes', async () => {
    const approved = matchedItem(41, 2, 'approved')
    seedRequests([approved])
    api.fetchRequestReleases.mockResolvedValue({ releases: Array.from({ length: 14 }, (_, index) => release(`g${index}`)) })
    api.grabRequestRelease.mockResolvedValue(matchedItem(41, 2, 'grabbed'))
    const state = setup({ canManage: true })
    await flush()

    await state.findReleases(approved)
    expect(api.fetchRequestReleases).toHaveBeenCalledWith(41)
    expect(state.releases.value[41]).toMatchObject({ state: 'ready', total: 14 })
    expect(state.releases.value[41]!.releases).toHaveLength(INLINE_RELEASE_LIMIT)

    await expect(state.grab(2, approved, release('g0'))).resolves.toBe(true)
    expect(api.grabRequestRelease).toHaveBeenCalledWith(41, 2, 'g0')
    expect(state.rows.value[1]!.request?.status).toBe('grabbed')
    expect(state.releases.value[41]).toBeUndefined()
  })

  it('reports a failed search and a refused grab on the volume', async () => {
    const approved = matchedItem(41, 2, 'approved')
    api.fetchRequestReleases.mockRejectedValue(new Error('Indexers did not answer'))
    api.grabRequestRelease.mockRejectedValue(new Error('The download client refused it'))
    const state = setup({ canManage: true })
    await flush()

    await state.findReleases(approved)
    expect(state.releases.value[41]).toMatchObject({ state: 'error', error: 'Indexers did not answer' })
    await expect(state.grab(2, approved, release('g0'))).resolves.toBe(false)
    expect(state.errors.value[2]).toBe('The download client refused it')
  })

  it('never searches or grabs for somebody without the manage permission', async () => {
    const state = setup()
    await flush()
    await state.findReleases(matchedItem(41, 2, 'approved'))
    await state.grab(2, matchedItem(41, 2, 'approved'), release('g0'))
    expect(api.fetchRequestReleases).not.toHaveBeenCalled()
    expect(api.grabRequestRelease).not.toHaveBeenCalled()
  })
})

describe('useWebSerialPublishedVolumes work in flight when the sheet changes', () => {
  function scoped(value: PublishedSeries = series()) {
    const seriesRef = ref<PublishedSeries | null>(value)
    const scope = effectScope()
    const state = scope.run(() =>
      useWebSerialPublishedVolumes(seriesRef, { canRequest: ref(true), canManage: ref(false), offered: ref(true), userId: ref<number | null>(7) }),
    )!
    return { seriesRef, scope, state }
  }

  it('records a request created after the sheet closed, against the series it was made for', async () => {
    let finish: () => void = () => undefined
    api.createVolumeRequest.mockImplementation(() => new Promise((resolve) => (finish = () => resolve({ request: item(51, 1), subscribed: false }))))
    const { scope, state } = scoped()
    await flush()

    const done = state.requestVolumeAnyway(1)
    await flush()
    scope.stop()
    finish()
    await done

    expect(api.recordPublishedRequest).toHaveBeenCalledWith({ kind: 'manga', matchId: '1234', volume: '1', bookRequestId: 51 })
  })

  it('records against the old series when the view moved to another one meanwhile', async () => {
    let finish: () => void = () => undefined
    api.createVolumeRequest.mockImplementation(() => new Promise((resolve) => (finish = () => resolve({ request: item(52, 1), subscribed: false }))))
    const { seriesRef, state } = scoped()
    await flush()

    const done = state.requestVolumeAnyway(1)
    await flush()
    seriesRef.value = series({ title: 'Wolf and Parchment', matchId: '77' })
    await flush()
    finish()
    await done

    expect(api.recordPublishedRequest).toHaveBeenCalledWith({ kind: 'manga', matchId: '1234', volume: '1', bookRequestId: 52 })
    expect(state.rows.value[0]!.request).toBeNull()
  })

  it('asks for and records the confirmed re-match even when the sheet closes after the cancel', async () => {
    seedRequests([freeTextItem(11, 1)])
    match.resolveVolume.mockResolvedValue(pick(1))
    let finishCancel: () => void = () => undefined
    api.cancelVolumeRequest.mockImplementation(
      (id) => new Promise((resolve) => (finishCancel = () => resolve({ ...item(id, 1), status: 'cancelled' }))),
    )
    api.createVolumeRequest.mockResolvedValue({ request: matchedItem(60, 1), subscribed: false })
    const { scope, state } = scoped()
    await flush()
    await state.rematchVolume(1)

    const confirming = state.confirmRematch()
    await flush()
    scope.stop()
    finishCancel()
    await confirming

    expect(api.createVolumeRequest).toHaveBeenCalledTimes(1)
    expect(api.recordPublishedRequest).toHaveBeenCalledWith({ kind: 'manga', matchId: '1234', volume: '1', bookRequestId: 60 })
  })

  it('stops a request-all run before the next volume when asked', async () => {
    match.resolveVolume.mockImplementation(async (_current, volume) => pick(volume))
    let finish: () => void = () => undefined
    api.createVolumeRequest.mockImplementation(
      (payload) =>
        new Promise(
          (resolve) =>
            (finish = () => resolve({ request: item(70 + (payload.seriesIndex as number), payload.seriesIndex as number), subscribed: false })),
        ),
    )
    const { state } = scoped()
    await flush()

    const run = state.requestAllMissing()
    await flush()
    state.stopRequestAll()
    expect(state.stopping.value).toBe(true)
    finish()
    await run

    expect(api.createVolumeRequest).toHaveBeenCalledTimes(1)
    expect(state.bulk.value).toBeNull()
    expect(state.stopping.value).toBe(false)
    expect(state.rows.value[0]!.request?.id).toBe(71)
  })
})
