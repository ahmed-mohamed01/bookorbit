import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseCandidateItem, ReleaseFileInspection, ReleaseSearchProgress, ReleaseSearchResult, WebSerialPrintState } from '@bookorbit/types'
import type { PublishedSeries } from '../lib/publishedVolumes'
import { useLightNovelAcquisition } from '../composables/useLightNovelAcquisition'
import * as endpoints from '../api/webSerials'
import { api } from '@/lib/api'
import { cancelVolumeRequest } from '../api/bookRequests'
import { streamReleaseSearch } from '@/features/book-requests/api/streamReleaseSearch'
vi.mock('../api/webSerials', () => ({
  requestPrintVolumes: vi.fn<typeof endpoints.requestPrintVolumes>(),
  createPrintDraft: vi.fn<typeof endpoints.createPrintDraft>(),
  closePrintDraft: vi.fn<typeof endpoints.closePrintDraft>(),
  fetchPrintState: vi.fn<typeof endpoints.fetchPrintState>(),
  fetchPrintSuggestion: vi.fn<typeof endpoints.fetchPrintSuggestion>(),
  downloadPrintVolumes: vi.fn<typeof endpoints.downloadPrintVolumes>(),
}))
vi.mock('../api/bookRequests', () => ({ cancelVolumeRequest: vi.fn<typeof cancelVolumeRequest>() }))
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
vi.mock('@/features/book-requests/api/streamReleaseSearch', () => ({ streamReleaseSearch: vi.fn<typeof streamReleaseSearch>() }))
const release: ReleaseCandidateItem = {
  indexerId: 1,
  indexerName: 'Source',
  guid: 'pack',
  title: 'Novel Vol. 1-3',
  infoUrl: null,
  sizeBytes: 100,
  seeders: 1,
  leechers: 0,
  format: 'epub',
  formats: ['epub'],
  language: null,
  fileCount: 3,
  freeleech: false,
  vipOnly: false,
  alreadyGrabbed: false,
  publishedAt: null,
  audio: null,
  score: 10,
  tier: null,
  inspectionWanted: false,
  tierName: null,
  profileMismatch: null,
  reasons: [],
}
const printState: WebSerialPrintState = {
  role: 'approver',
  downloads: [],
  bookRequestId: 2,
  seriesRequestId: 1,
  volumes: [1, 2, 3].map((volume) => ({ volume, state: volume === 1 ? 'owned' : 'missing', bookId: null, error: null })),
}
const result: ReleaseSearchResult = {
  releases: [release],
  criteria: {
    title: 'Novel',
    authors: [],
    isbn10: null,
    isbn13: null,
    activeIsbn: null,
    isbns: [],
    mediaKind: 'ebook',
    language: null,
    preferredFormats: [],
  },
  indexers: [],
  uncoveredIndexerCount: 0,
  enabledIndexerCount: 1,
  configuredIndexerCount: 1,
  profileActive: false,
  searchedAt: '',
  cached: false,
}
const inspection: ReleaseFileInspection = {
  ranking: null,
  source: 'torrent_file',
  status: 'ready',
  files: [],
  totalFiles: 3,
  primaryFileCount: 3,
  truncated: false,
  units: [],
  unitCount: 3,
  ignoredFileCount: 0,
  containerCount: 0,
  selection: {
    rootName: null,
    files: [],
    units: [1, 2, 3].map((volume) => ({
      index: volume - 1,
      title: `Novel Vol. ${volume}`,
      mediaKind: 'ebook',
      sizeBytes: 10,
      primaryPath: `${volume}.epub`,
    })),
  },
}
const series: PublishedSeries = {
  kind: 'novel',
  matchId: '123',
  title: 'Novel',
  authors: [],
  url: 'https://example.com',
  publication: { licensed: true, finalVolume: 3, publishers: [] },
}
const scopes: ReturnType<typeof effectScope>[] = []
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function mount(role: 'approver' | 'requester' = 'approver', current = series) {
  const scope = effectScope()
  scopes.push(scope)
  return { scope, flow: scope.run(() => useLightNovelAcquisition(ref(current), { role, canManage: true }))! }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.mocked(endpoints.createPrintDraft).mockResolvedValue({ seriesRequestId: 1, bookRequestId: 2 })
  vi.mocked(endpoints.closePrintDraft).mockResolvedValue()
  vi.mocked(endpoints.fetchPrintState).mockResolvedValue(structuredClone(printState))
  vi.mocked(endpoints.fetchPrintSuggestion).mockResolvedValue({ releases: [{ indexerId: 1, guid: 'pack' }], volumes: [2, 3], sizeBytes: 100 })
  vi.mocked(endpoints.downloadPrintVolumes).mockResolvedValue(structuredClone(printState))
  vi.mocked(streamReleaseSearch).mockResolvedValue(result)
  vi.mocked(api).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).endsWith('inspect') ? inspection : [{ id: 5, name: 'Client', color: null, delivery: 'torrent', fileSelection: true }],
        ),
      ),
  )
})
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.useRealTimers()
})
describe('light novel acquisition', () => {
  it('leaves off-series releases unmatched while retaining matching volumes', async () => {
    vi.mocked(streamReleaseSearch).mockResolvedValue({
      ...result,
      releases: [
        { ...release, guid: 'tabletop', title: "2-Minute Tabletop's Everything Pack V7 by 2-Minute Tabletop [ENG] [VIP]" },
        { ...release, title: 'The Water Magician Vol. 7 (Yen Press) [EPUB]' },
      ],
    })
    const { flow } = mount('approver', {
      ...series,
      title: 'The Water Magician: The Central Provinces Arc',
      publication: { ...series.publication!, finalVolume: 7 },
    })
    await flush()
    expect(flow.releases.value.map(({ volumes }) => volumes)).toEqual([[], [7]])
  })

  it('requests chosen volumes and cancels the current series request without a draft', async () => {
    vi.mocked(endpoints.requestPrintVolumes).mockResolvedValue({ ...printState, role: 'requester' })
    vi.mocked(cancelVolumeRequest).mockResolvedValue({} as Awaited<ReturnType<typeof cancelVolumeRequest>>)
    const { flow } = mount('requester')
    await flush()
    await flow.requestVolumes([2, 3])
    expect(endpoints.requestPrintVolumes).toHaveBeenCalledWith(series.matchId, {
      title: series.title,
      altTitles: [],
      authors: series.authors,
      url: series.url,
      volumeCount: 3,
      volumes: [2, 3],
    })
    await flow.cancelRequest()
    expect(cancelVolumeRequest).toHaveBeenCalledWith(2)
    expect(endpoints.createPrintDraft).not.toHaveBeenCalled()
  })

  it('streams progress and preserves timeout chips', async () => {
    const progress: ReleaseSearchProgress = {
      ...result,
      pending: [{ indexerId: 2, indexerName: 'Waiting', color: null }],
      indexers: [
        {
          indexerId: 1,
          indexerName: 'Source',
          color: null,
          ok: false,
          count: 0,
          filtered: 0,
          seedsBack: true,
          delivery: 'torrent',
          failure: 'timeout',
        },
      ],
    }
    vi.mocked(streamReleaseSearch).mockImplementation(async (_path, _body, onProgress) => {
      onProgress(progress)
      await new Promise<void>(() => {})
      return result
    })
    const { flow } = mount()
    await flush()
    expect(flow.search.indexers.value[0]?.failure).toBe('timeout')
    expect(flow.search.pending.value).toHaveLength(1)
    expect(flow.search.results.value).toEqual([release])
    expect(streamReleaseSearch).toHaveBeenCalledWith(
      '/api/v1/admin/book-requests/2/releases/stream',
      { overrides: { title: 'Novel', authors: [] } },
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })
  it('filters volumes, selects suggestions, narrows pack coverage and sends only DTO fields', async () => {
    const { flow } = mount()
    await flush()
    flow.toggleVolume(2)
    expect(flow.releases.value).toHaveLength(1)
    flow.toggleVolume(2)
    expect(flow.volumeFilter.value.size).toBe(0)
    flow.showMissingOnly()
    expect([...flow.volumeFilter.value]).toEqual([2, 3])
    flow.clearFilter()
    flow.pickSuggestion()
    expect(flow.picks.value.has('1:pack')).toBe(true)
    await flow.inspect(release)
    expect([...flow.fileSelection.value.get('1:pack')!]).toEqual([1, 2])
    flow.fileSelection.value.get('1:pack')!.delete(2)
    expect(flow.plannedVolumes.value.get('1:pack')).toEqual([2])
    await flow.send()
    expect(endpoints.downloadPrintVolumes).toHaveBeenCalledWith('123', {
      title: 'Novel',
      altTitles: [],
      volumeCount: 3,
      seriesRequestId: 1,
      downloadClientId: 5,
      picks: [{ indexerId: 1, releaseGuid: 'pack', unitIndexes: [1], volumes: [2], downloadClientId: 5 }],
    })
    expect(endpoints.fetchPrintSuggestion).toHaveBeenCalledWith('123', {
      title: 'Novel',
      altTitles: [],
      volumeCount: 3,
      seriesRequestId: 1,
      query: { title: 'Novel', authors: [] },
    })
  })
  it('an uninspected pack never sends unitIndexes null', async () => {
    const { flow } = mount()
    await flush()
    let resolve!: (response: Response) => void
    vi.mocked(api).mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done
      }),
    )
    flow.togglePick(release)
    expect(flow.inspecting.value.has('1:pack')).toBe(true)
    expect(flow.selected.value).toEqual([])
    expect(flow.bar.value.canSend).toBe(false)
    await flow.send()
    expect(endpoints.downloadPrintVolumes).not.toHaveBeenCalled()
    resolve(new Response(JSON.stringify(inspection)))
    await flush()
    expect(flow.bar.value).toEqual({ volumes: [2, 3], volumeCount: 2, releaseCount: 1, sizeBytes: 100, canSend: true })
    await flow.send()
    expect(vi.mocked(endpoints.downloadPrintVolumes).mock.calls[0]?.[1].picks[0]?.unitIndexes).toEqual([1, 2])
    flow.togglePick(release)
    flow.fileSelection.value.get('1:pack')!.clear()
    expect(flow.bar.value.canSend).toBe(false)
  })
  it('pickSuggestion inspects every suggested release before the bar can send', async () => {
    const second = { ...release, guid: 'second' }
    vi.mocked(streamReleaseSearch).mockResolvedValue({ ...result, releases: [release, second] })
    vi.mocked(endpoints.fetchPrintSuggestion).mockResolvedValue({ releases: [release, second], volumes: [2, 3], sizeBytes: 200 })
    const { flow } = mount()
    await flush()
    const resolvers: ((response: Response) => void)[] = []
    vi.mocked(api).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    flow.pickSuggestion()
    expect(resolvers).toHaveLength(2)
    expect(flow.inspecting.value.size).toBe(2)
    resolvers[0]!(new Response(JSON.stringify(inspection)))
    await flush()
    expect(flow.bar.value.releaseCount).toBe(1)
    expect(flow.bar.value.canSend).toBe(false)
    resolvers[1]!(new Response(JSON.stringify(inspection)))
    await flush()
    expect(flow.bar.value.releaseCount).toBe(2)
    expect(flow.bar.value.canSend).toBe(true)
  })
  it('keeps failed inspections out of selected and exposes their errors', async () => {
    const { flow } = mount()
    await flush()
    const failure = new Error('Inspection failed')
    vi.mocked(api).mockRejectedValue(failure)
    flow.togglePick(release)
    await flush()
    expect(flow.selected.value).toEqual([])
    expect(flow.inspectionErrors.value.get('1:pack')).toBe(failure)
    expect(flow.inspecting.value.size).toBe(0)
  })
  it.each([true, false])('prefers file selection clients with fallback: %s', async (fileSelection) => {
    vi.mocked(api).mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 6, name: 'First', color: null, delivery: 'torrent', fileSelection: false },
          { id: 7, name: 'Second', color: null, delivery: 'torrent', fileSelection },
        ]),
      ),
    )
    const { flow } = mount()
    await flush()
    expect(flow.clientId.value).toBe(fileSelection ? 7 : 6)
  })
  it('polls unsettled downloads and stops on disposal', async () => {
    vi.mocked(endpoints.fetchPrintState).mockResolvedValue({
      ...printState,
      downloads: [{ key: 'x', title: 'Pack', kind: 'batch', volumes: [2], status: 'downloading', percent: 10, error: null }],
    })
    const { scope } = mount()
    await flush()
    expect(endpoints.fetchPrintState).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(endpoints.fetchPrintState).toHaveBeenCalledTimes(3)
    scope.stop()
    await vi.advanceTimersByTimeAsync(15000)
    expect(endpoints.fetchPrintState).toHaveBeenCalledTimes(3)
    expect(endpoints.closePrintDraft).toHaveBeenCalledExactlyOnceWith('123', 1)
  })
  it('disables sending immediately on close', async () => {
    const { flow } = mount()
    await flush()
    flow.togglePick(release)
    await flush()
    expect(flow.bar.value.canSend).toBe(true)
    flow.closeDraft()
    expect(flow.bar.value.canSend).toBe(false)
    await flow.send()
    expect(endpoints.downloadPrintVolumes).not.toHaveBeenCalled()
  })
  it('sorts light novels before off-format results and filters by coverage', async () => {
    vi.mocked(streamReleaseSearch).mockResolvedValue({
      ...result,
      releases: [
        { ...release, guid: 'manga', title: 'Novel Manga Vol. 2', score: 100 },
        { ...release, guid: 'single', title: 'Novel Vol. 1' },
        release,
      ],
    })
    const { flow } = mount()
    await flush()
    expect(flow.releases.value.map((item) => item.guid)).toEqual(['single', 'pack', 'manga'])
    flow.toggleVolume(3)
    expect(flow.releases.value.map((item) => item.guid)).toEqual(['pack'])
  })
  it('uses encoded API paths and keepalive cleanup', async () => {
    const actual = await vi.importActual<typeof endpoints>('../api/webSerials')
    await actual.closePrintDraft('a/b', 7)
    expect(api).toHaveBeenCalledWith('/api/v1/web-serials/novel/a%2Fb/draft/7', { method: 'DELETE', keepalive: true })
  })
  it('requesters read state without opening drafts or searches', async () => {
    mount('requester')
    await flush()
    expect(endpoints.createPrintDraft).not.toHaveBeenCalled()
    expect(streamReleaseSearch).not.toHaveBeenCalled()
    expect(endpoints.fetchPrintState).toHaveBeenCalledOnce()
  })
})

it.each([0, 1])('blocks uninspectable releases and one-file omnibuses: %s', async (unitCount) => {
  const { flow } = mount()
  await flush()
  vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ ...inspection, unitCount })))
  flow.togglePick(release)
  await flush()
  expect(flow.bar.value.canSend).toBe(false)
  await flow.send()
  expect(endpoints.downloadPrintVolumes).not.toHaveBeenCalled()
})
it('refreshes the full series after sending and keeps per-pick failures visible', async () => {
  const { flow } = mount()
  await flush()
  flow.togglePick(release)
  await flush()
  vi.mocked(endpoints.downloadPrintVolumes).mockResolvedValue({
    ...printState,
    volumes: [],
    failures: [{ indexerId: 1, releaseGuid: 'pack', error: 'Refused' }],
  })
  await flow.send()
  expect(endpoints.fetchPrintState).toHaveBeenCalledTimes(3)
  expect(flow.state.value?.volumes).toHaveLength(3)
  expect(flow.inspectionErrors.value.get('1:pack')).toEqual(new Error('Refused'))
  flow.closeDraft()
  expect(endpoints.closePrintDraft).not.toHaveBeenCalled()
})
it('does not delete a draft while sending', async () => {
  const { flow } = mount()
  await flush()
  flow.togglePick(release)
  await flush()
  let resolve!: (value: WebSerialPrintState) => void
  vi.mocked(endpoints.downloadPrintVolumes).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const sending = flow.send()
  flow.closeDraft()
  expect(endpoints.closePrintDraft).not.toHaveBeenCalled()
  resolve(printState)
  await sending
})
it.each(['held', 'filed', 'failed'] as const)('does not poll settled %s downloads', async (status) => {
  vi.mocked(endpoints.fetchPrintState).mockResolvedValue({
    ...printState,
    downloads: [{ key: 'held', title: 'Review', kind: 'single', volumes: [2], status, percent: null, error: 'Check match' }],
  })
  mount()
  await flush()
  await vi.advanceTimersByTimeAsync(15000)
  expect(endpoints.fetchPrintState).toHaveBeenCalledTimes(2)
})

it('default search uses the base title without author', async () => {
  mount('approver', { ...series, title: 'The Water Magician: The Central Provinces Arc', authors: ['Tadashi Kubou'] })
  await flush()
  expect(vi.mocked(streamReleaseSearch).mock.calls[0]?.[1]).toEqual({ overrides: { title: 'The Water Magician', authors: [] } })
  expect(streamReleaseSearch).toHaveBeenCalledTimes(1)
})
it('preserves a colon without following whitespace', async () => {
  mount('approver', { ...series, title: 'Re:ZERO' })
  await flush()
  expect(vi.mocked(streamReleaseSearch).mock.calls[0]?.[1]).toEqual({ overrides: { title: 'Re:ZERO', authors: [] } })
})
it('reruns with author when the first search is empty', async () => {
  vi.mocked(streamReleaseSearch).mockResolvedValue({ ...result, releases: [] })
  const { flow } = mount('approver', { ...series, title: 'Novel: Arc', authors: ['First', 'Second'] })
  await flush()
  expect(streamReleaseSearch).toHaveBeenCalledTimes(2)
  expect(vi.mocked(streamReleaseSearch).mock.calls.map((call) => call[1])).toEqual([
    { overrides: { title: 'Novel', authors: [] } },
    { overrides: { title: 'Novel', authors: ['First'] } },
  ])
  expect(flow.query.value).toEqual({ title: 'Novel', author: 'First' })
})
it('searchWith sends overrides and resets picks', async () => {
  const { flow } = mount()
  await flush()
  flow.pickSuggestion()
  await flush()
  expect(flow.fileSelection.value.size).toBe(1)
  let resolve!: (value: ReleaseSearchResult) => void
  vi.mocked(streamReleaseSearch).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const searching = flow.searchWith({ title: 'Romaji title', author: 'Writer' })
  expect(flow.picks.value.size).toBe(0)
  expect(flow.fileSelection.value.size).toBe(0)
  expect(flow.suggestion.value).toBeNull()
  expect(vi.mocked(streamReleaseSearch).mock.lastCall?.[1]).toEqual({ overrides: { title: 'Romaji title', authors: ['Writer'] } })
  resolve(result)
  await searching
  expect(endpoints.fetchPrintSuggestion).toHaveBeenCalledTimes(2)
  expect(flow.query.value).toEqual({ title: 'Romaji title', author: 'Writer' })
})

it('suggestion request carries the active query', async () => {
  const { flow } = mount()
  await flush()
  expect(endpoints.fetchPrintSuggestion).toHaveBeenLastCalledWith(
    series.matchId,
    expect.objectContaining({ query: { title: flow.query.value.title, authors: [] } }),
  )
  await flow.searchWith({ title: 'Romaji title', author: 'Writer' })
  expect(endpoints.fetchPrintSuggestion).toHaveBeenLastCalledWith(
    series.matchId,
    expect.objectContaining({ query: { title: 'Romaji title', authors: ['Writer'] } }),
  )
})

it('loads volumes while the initial search is still pending', async () => {
  vi.mocked(streamReleaseSearch).mockReturnValue(new Promise(() => {}))
  const { flow } = mount()
  await flush()
  expect(flow.search.status.value).toBe('loading')
  expect(flow.state.value?.volumes).toEqual(printState.volumes)
})
const single: ReleaseCandidateItem = { ...release, guid: 'single', title: 'Novel Vol. 2', fileCount: 1 }
const singleInspection: ReleaseFileInspection = { ...inspection, unitCount: 1, totalFiles: 1, primaryFileCount: 1, selection: null }
function directSearch(delivery: 'file' | 'shelfmark' | 'usenet', releases: ReleaseCandidateItem[]) {
  vi.mocked(streamReleaseSearch).mockResolvedValue({
    ...result,
    releases,
    indexers: [{ indexerId: 1, indexerName: 'Direct', delivery, ok: true, count: 1, filtered: 0, seedsBack: false, color: null }],
  })
}
function respond(inspected: ReleaseFileInspection, clients: unknown[]) {
  vi.mocked(api).mockImplementation(async (path) => new Response(JSON.stringify(String(path).endsWith('inspect') ? inspected : clients)))
}
it.each(['file', 'shelfmark', 'usenet'] as const)('sends a null client for %s single-file picks', async (delivery) => {
  directSearch(delivery, [single])
  respond(singleInspection, [{ id: 5, name: 'Client', color: null, delivery: 'torrent', fileSelection: true }])
  const { flow } = mount()
  await flush()
  flow.togglePick(single)
  await flush()
  expect(flow.needsClient.value).toBe(false)
  expect(flow.bar.value.canSend).toBe(true)
  await flow.send()
  expect(endpoints.downloadPrintVolumes).toHaveBeenCalledWith(
    '123',
    expect.objectContaining({
      picks: [expect.objectContaining({ unitIndexes: null, volumes: [2], downloadClientId: null })],
    }),
  )
})
it('sends a direct pick when no download client is configured', async () => {
  directSearch('file', [single])
  respond(singleInspection, [])
  const { flow } = mount()
  await flush()
  flow.togglePick(single)
  await flush()
  expect(flow.bar.value.canSend).toBe(true)
  await flow.send()
  const payload = vi.mocked(endpoints.downloadPrintVolumes).mock.calls[0]![1]
  expect(payload).not.toHaveProperty('downloadClientId')
  expect(payload.picks).toEqual([expect.objectContaining({ downloadClientId: null })])
})
it.each(['file', 'shelfmark', 'usenet'] as const)('sends the chosen client for %s multi-file picks', async (delivery) => {
  directSearch(delivery, [release])
  const { flow } = mount()
  await flush()
  flow.togglePick(release)
  await flush()
  expect(flow.needsClient.value).toBe(true)
  expect(flow.bar.value.canSend).toBe(true)
  await flow.send()
  expect(endpoints.downloadPrintVolumes).toHaveBeenCalledWith(
    '123',
    expect.objectContaining({
      downloadClientId: 5,
      picks: [expect.objectContaining({ unitIndexes: [1, 2], volumes: [2, 3], downloadClientId: 5 })],
    }),
  )
})
it('blocks a non-torrent multi-file pick when no download client is configured', async () => {
  directSearch('usenet', [release])
  respond(inspection, [])
  const { flow } = mount()
  await flush()
  flow.togglePick(release)
  await flush()
  expect(flow.selected.value).toHaveLength(1)
  expect(flow.needsClient.value).toBe(true)
  expect(flow.bar.value.canSend).toBe(false)
  await flow.send()
  expect(endpoints.downloadPrintVolumes).not.toHaveBeenCalled()
})
it('blocks a non-torrent multi-file pick when the client cannot skip files', async () => {
  directSearch('file', [release])
  respond(inspection, [{ id: 6, name: 'Plain', color: null, delivery: 'torrent', fileSelection: false }])
  const { flow } = mount()
  await flush()
  flow.togglePick(release)
  await flush()
  expect(flow.clientId.value).toBe(6)
  expect(flow.bar.value.canSend).toBe(false)
})
