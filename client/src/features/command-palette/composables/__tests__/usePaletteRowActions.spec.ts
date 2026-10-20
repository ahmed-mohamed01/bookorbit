import { beforeEach, expect, it, vi } from 'vitest'
import type { HardcoverSearchBook, MonitoredCatalogSearchHit } from '@bookorbit/types'
import type { requestMonitoredWork, monitorAuthor } from '@/features/monitored/api/monitored'
import { workFixture } from '@/features/monitored/testing/work-fixture'
import { usePaletteRowActions } from '../usePaletteRowActions'
const mocks = vi.hoisted(() => ({
  request: vi.fn<typeof requestMonitoredWork>(),
  follow: vi.fn<typeof monitorAuthor>(),
}))
vi.mock('@/features/monitored/api/monitored', () => ({ requestMonitoredWork: mocks.request, monitorAuthor: mocks.follow }))
const requestVisibility = vi.hoisted(() => ({ showBookRequests: { value: true } }))
vi.mock('@/features/book-requests/composables/useBookRequestVisibility', () => ({ useBookRequestVisibility: () => requestVisibility }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<(message: string) => void>(), success: vi.fn<(message: string) => void>() } }))
const hit = (): MonitoredCatalogSearchHit => ({
  work: workFixture(),
  authorName: 'Author',
  monitorAuthorId: 'a',
  authorModes: { ebook: 'notify', audiobook: 'off' },
})
beforeEach(() => vi.clearAllMocks())
it('never offers an ebook-only author audiobook', () => {
  const row = hit()
  row.work.ownedFormats = ['ebook']
  const actions = usePaletteRowActions()
  expect(actions.requestFormat(row)).toBeUndefined()
  expect(actions.watchedFormats(row).map((f) => f.format)).toEqual(['ebook'])
})
it('offers no request when Requests is hidden', () => {
  requestVisibility.showBookRequests.value = false
  try {
    expect(usePaletteRowActions().requestFormat(hit())).toBeUndefined()
  } finally {
    requestVisibility.showBookRequests.value = true
  }
})
it('offers audiobook for audiobook-only works', () => {
  const row = hit()
  row.authorModes.audiobook = 'notify'
  row.work.ebookReleaseDate = null
  expect(usePaletteRowActions().requestFormat(row)).toBe('audiobook')
})
it('offers an ebook whose only date is an expected hint on its probe row', () => {
  const row = hit()
  row.work.ebookReleaseDate = null
  row.work.audioReleaseDate = '2026-05-01'
  row.work.formatReleases = {
    ebook: {
      status: 'expected',
      releaseDate: '2026-01-13',
      precision: 'day',
      source: null,
      checkedAt: null,
      dateChangedAt: null,
      previousReleaseDate: null,
      previousPrecision: null,
      suggested: null,
    },
  }
  expect(usePaletteRowActions().requestFormat(row)).toBe('ebook')
})
it('offers nothing after a successful request', async () => {
  const row = hit()
  row.authorModes.audiobook = 'notify'
  mocks.request.mockResolvedValue(workFixture({ requestIds: { ebook: 1 }, requestStatuses: { ebook: 'approved' } }))
  const actions = usePaletteRowActions()
  await actions.requestWork(row)
  expect(actions.requestFormat(row)).toBeUndefined()
  await actions.requestWork(row)
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('work-1', { format: 'ebook' })
  expect(actions.requestFormat({ ...row })).toBe('audiobook')
})
it('shares in-flight and completed follow state across author rows', async () => {
  let finish!: (value: Awaited<ReturnType<typeof monitorAuthor>>) => void
  mocks.follow.mockReturnValue(
    new Promise<Awaited<ReturnType<typeof monitorAuthor>>>((resolve) => {
      finish = resolve
    }),
  )
  const a = { authorNames: [' Author '] } as HardcoverSearchBook
  const b = { authorNames: ['author'] } as HardcoverSearchBook
  const actions = usePaletteRowActions()
  const pending = actions.followAuthor(a)
  expect(actions.isFollowing(b)).toBe(true)
  await actions.followAuthor(b)
  expect(mocks.follow).toHaveBeenCalledOnce()
  finish({
    id: 'a',
    ownerUserId: 1,
    authorName: 'Author',
    localAuthorId: null,
    providerIds: {},
    formats: { ebook: { mode: 'notify', libraryId: null, folderId: null }, audiobook: { mode: 'off', libraryId: null, folderId: null } },
    paused: false,
    addedAt: '2026-01-01',
    lastRefreshedAt: null,
    fetch: { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
    isOwner: true,
    counts: { total: 0, ebookOwned: 0, audioOwned: 0, hidden: 0 },
    nextReleaseAt: null,
    portraitAuthorId: null,
    description: null,
    website: null,
    genres: [],
  })
  await pending
  expect(actions.isFollowed(b)).toBe(true)
})
it('does not let render-time follow checks choose canonical spelling', async () => {
  mocks.follow.mockRejectedValue(new Error('offline'))
  const actions = usePaletteRowActions()
  actions.isFollowed({ authorNames: ['AUTHOR'] } as HardcoverSearchBook)
  await actions.followAuthor({ authorNames: ['Author'] } as HardcoverSearchBook)
  expect(mocks.follow.mock.calls[0]?.[0]).toMatchObject({ authorName: 'Author' })
})
