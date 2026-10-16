import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredAuthorDetail, MonitoredWork } from '@bookorbit/types'
import { fetchMonitoredAuthorDetail, refreshMonitoredAuthor, requestMonitoredWork, updateMonitoredWork } from '../api/monitored'
import { storage } from '@/services/storage'
import { useMonitoredAuthorDetail } from './useMonitoredAuthorDetail'

const routeState = vi.hoisted(() => ({
  authorId: 'author-1',
  name: 'monitored-author',
  query: {} as Record<string, string>,
  replace: vi.fn<(location: unknown) => Promise<void>>(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: routeState.name, params: { id: routeState.authorId }, query: routeState.query }),
  useRouter: () => ({ replace: routeState.replace }),
}))

vi.mock('../api/monitored', () => ({
  fetchMonitoredAuthorDetail: vi.fn<() => Promise<MonitoredAuthorDetail>>(),
  refreshMonitoredAuthor: vi.fn<() => Promise<MonitoredAuthorDetail>>(),
  requestMonitoredWork: vi.fn<() => Promise<never>>(),
  updateMonitoredAuthor: vi.fn<() => Promise<never>>(),
  updateMonitoredWork: vi.fn<() => Promise<MonitoredWork>>(),
}))

const fetchDetailMock = vi.mocked(fetchMonitoredAuthorDetail)
const refreshMock = vi.mocked(refreshMonitoredAuthor)
const requestWorkMock = vi.mocked(requestMonitoredWork)
const updateWorkMock = vi.mocked(updateMonitoredWork)

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

function detail(): MonitoredAuthorDetail {
  return {
    author: {
      id: 'author-1',
      ownerUserId: 1,
      authorName: 'A Writer',
      localAuthorId: null,
      providerIds: {},
      formats: { ebook: { mode: 'notify', libraryId: null, folderId: null }, audiobook: { mode: 'off', libraryId: null, folderId: null } },
      paused: false,
      addedAt: '2026-01-01',
      lastRefreshedAt: null,
      isOwner: true,
      counts: { total: 1, ebookOwned: 0, audioOwned: 0, hidden: 0 },
      nextReleaseAt: null,
      portraitAuthorId: null,
      description: null,
      website: null,
      genres: [],
    },
    works: [work()],
  }
}

function mountComposable() {
  let composable!: ReturnType<typeof useMonitoredAuthorDetail>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useMonitoredAuthorDetail()
        return () => null
      },
    }),
  )
  return { composable, wrapper }
}

describe('useMonitoredAuthorDetail', () => {
  beforeEach(() => {
    fetchDetailMock.mockReset()
    requestWorkMock.mockReset()
    refreshMock.mockReset()
    updateWorkMock.mockReset()
    fetchDetailMock.mockResolvedValue(detail())
    routeState.name = 'monitored-author'
    routeState.query = {}
    routeState.replace.mockReset()
  })

  it('defaults the status filter to every status except hidden, including owned and not watched', async () => {
    storage.remove('monitored:authorDetail:status')
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.statusFilters.value).toEqual(['missing', 'in_progress', 'needs_attention', 'upcoming', 'in_library', 'not_watched'])
    expect(fetchDetailMock).toHaveBeenCalledWith(
      'author-1',
      expect.objectContaining({ status: ['missing', 'in_progress', 'needs_attention', 'upcoming', 'in_library', 'not_watched', 'hidden'] }),
    )
    wrapper.unmount()
  })

  it('ignores a selection stored under the old key', () => {
    storage.set('monitored:authorDetail:status', ['missing'])
    const { composable, wrapper } = mountComposable()

    expect(composable.statusFilters.value).toContain('in_library')
    storage.remove('monitored:authorDetail:status')
    wrapper.unmount()
  })

  it('shows the same works after a refresh as a reload would', async () => {
    const filtered = detail()
    fetchDetailMock.mockResolvedValue(filtered)
    refreshMock.mockResolvedValue({ ...filtered, works: [work({ id: 'unfiltered-extra' })] })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    const before = composable.detail.value?.works.map((entry) => entry.id)
    fetchDetailMock.mockClear()

    await composable.refreshAuthor()

    expect(refreshMock).toHaveBeenCalledWith('author-1')
    expect(fetchDetailMock).toHaveBeenCalledTimes(1)
    expect(composable.detail.value?.works.map((entry) => entry.id)).toEqual(before)
    wrapper.unmount()
  })

  it('persists a hide through the API and reflects the server copy of the work', async () => {
    const hidden = work({ userVisibility: 'hidden' })
    updateWorkMock.mockResolvedValue(hidden)
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.updateWork('work-1', { hidden: true })

    expect(updateWorkMock).toHaveBeenCalledWith('work-1', { hidden: true })
    expect(composable.detail.value?.works[0]).toEqual(hidden)
    expect(composable.visibleWorks.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('surfaces a failed hide instead of pretending it stuck', async () => {
    updateWorkMock.mockRejectedValue(new Error('nope'))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await expect(composable.updateWork('work-1', { hidden: true })).rejects.toThrow('nope')
    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('clears the hidden mark again when updateWork unhides', async () => {
    updateWorkMock.mockResolvedValue(work({ userVisibility: 'hidden' }))
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.updateWork('work-1', { hidden: true })

    updateWorkMock.mockResolvedValue(work())
    await composable.updateWork('work-1', { hidden: false })

    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('records a bulk hide without waiting for a refetch', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.recordVisibilityChange(['work-1'], { hidden: true })

    expect(composable.visibleWorks.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('records a bulk unhide and a bulk return to the automatic verdict', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    composable.recordVisibilityChange(['work-1'], { hidden: true })
    expect(composable.visibleWorks.value).toHaveLength(0)

    composable.recordVisibilityChange(['work-1'], { hidden: false })
    expect(composable.visibleWorks.value).toHaveLength(1)

    composable.recordVisibilityChange(['work-1'], { hidden: true })
    composable.recordVisibilityChange(['work-1'], { automaticVisibility: true })
    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('leaves the hidden set alone for a monitor-only patch', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.recordVisibilityChange(['work-1'], { monitorEbook: true })

    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('offers no local-only stop path that skips the server', () => {
    const { composable, wrapper } = mountComposable()

    expect('stopMonitoringWork' in composable).toBe(false)
    wrapper.unmount()
  })

  it('passes auto-download when provided and omits it when undefined', async () => {
    requestWorkMock.mockResolvedValue(work({ requestIds: { ebook: 41, audiobook: 42 } }))
    const { composable, wrapper } = mountComposable()

    await composable.queueWork('work-1', 'ebook', false)
    await composable.queueWork('work-1', 'audiobook')

    expect(requestWorkMock).toHaveBeenNthCalledWith(1, 'work-1', { format: 'ebook', autoDownload: false })
    expect(requestWorkMock).toHaveBeenNthCalledWith(2, 'work-1', { format: 'audiobook' })
    wrapper.unmount()
  })

  it('replaces optimistic queue state with the request state returned by the server', async () => {
    requestWorkMock.mockResolvedValue(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'grabbed' } }))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.queueWork('work-1', 'ebook')

    expect(composable.isQueued('work-1', 'ebook')).toBe(false)
    expect(composable.isQueued('work-1')).toBe(false)
    expect(composable.detail.value?.works[0]?.requestStatuses).toEqual({ ebook: 'grabbed' })
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail formats', () => {
  beforeEach(() => {
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue(detail())
  })

  it('derives the active author formats, skipping any format set to off', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.monitoredFormats.value).toEqual(['ebook'])
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail display options', () => {
  const reviewDetail = (): MonitoredAuthorDetail => {
    const base = detail()
    return {
      author: { ...base.author, counts: { ...base.author.counts, total: 1, hidden: 4 } },
      works: [
        work(),
        work({ id: 'box-set', title: 'The Complete Saga', verdict: 'suspect', kind: 'collection' }),
        work({ id: 'comic', title: 'The Comic', verdict: 'suspect', kind: 'graphic_novel' }),
        work({ id: 'obscure', title: 'Something Obscure', verdict: 'probable' }),
        work({ id: 'stub', title: 'Untitled', verdict: 'probable', flags: ['placeholder'] }),
        work({ id: 'buried', title: 'Buried', userVisibility: 'hidden' }),
      ],
    }
  }

  beforeEach(() => {
    storage.remove('monitored:authorDetail:display')
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue(reviewDetail())
  })

  it('shows only the default class, while already knowing what the other switches would reveal', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1'])
    // Counts used to arrive only once a switch forced a second fetch, so the menu opened blank.
    expect(composable.displayCounts.value).toEqual({ hidden: 1, placeholder: 1, review: 3 })
    expect(composable.reviewKindCounts.value.all).toBe(3)
    wrapper.unmount()
  })

  it('never refetches for a switch, because every class was fetched up front', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    expect(fetchDetailMock).toHaveBeenCalledWith('author-1', expect.objectContaining({ includeHidden: true }))
    fetchDetailMock.mockClear()

    composable.setDisplay({ ...composable.display.value, review: true })
    composable.setDisplay({ ...composable.display.value, hidden: true })
    await Promise.resolve()

    expect(fetchDetailMock).not.toHaveBeenCalled()
    // Default + review + hidden; the placeholder stays out because its own switch is still off.
    expect(composable.visibleWorks.value).toHaveLength(5)
    wrapper.unmount()
  })

  it('counts each class once, so a placeholder is never also counted under review', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.displayCounts.value).toEqual({ hidden: 1, placeholder: 1, review: 3 })
    expect(composable.reviewKindCounts.value).toMatchObject({ all: 3, collection: 1, graphic_novel: 1, other: 1, anthology: 0 })
    wrapper.unmount()
  })

  it('narrows the review class to the picked kinds without disturbing the default list', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true })
    await composable.load()

    composable.setDisplay({ ...composable.display.value, reviewKinds: ['collection'] })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set'])

    // Several kinds at once is the point of the multi-select.
    composable.setDisplay({ ...composable.display.value, reviewKinds: ['collection', 'graphic_novel'] })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set', 'comic'])
    wrapper.unmount()
  })

  it('drops the selection when review is collapsed, so re-expanding starts from all', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection'] })
    await composable.load()

    composable.setDisplay({ ...composable.display.value, review: false, reviewKinds: 'all' })
    composable.setDisplay({ ...composable.display.value, review: true })

    expect(composable.display.value.reviewKinds).toBe('all')
    wrapper.unmount()
  })

  it('reveals a work the owner hid only when hidden is switched on', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, hidden: true })
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'buried'])
    wrapper.unmount()
  })

  it('falls back to all when a reload leaves every picked kind empty', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection'] })
    await composable.load()

    // The next author has a tray, but nothing in it is a collection, and an absent kind is not listed.
    fetchDetailMock.mockResolvedValue({
      author: detail().author,
      works: [work(), work({ id: 'comic', verdict: 'suspect', kind: 'graphic_novel' })],
    })
    await composable.load()

    expect(composable.display.value.reviewKinds).toBe('all')
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'comic'])
    wrapper.unmount()
  })

  it('keeps a selection that still matches something, even when part of it is absent here', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection', 'duplicate'] })
    await composable.load()

    expect(composable.display.value.reviewKinds).toEqual(['collection', 'duplicate'])
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set'])
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail release switches', () => {
  const dated = (): MonitoredAuthorDetail => ({
    author: detail().author,
    works: [
      work({ id: 'out', title: 'Already Out', ebookReleaseDate: '2020-01-01', ebookDatePrecision: 'day' }),
      work({ id: 'soon', title: 'Coming Soon', ebookReleaseDate: '2099-01-01', ebookDatePrecision: 'day' }),
      work({ id: 'tba', title: 'No Date At All' }),
    ],
  })

  beforeEach(() => {
    storage.remove('monitored:authorDetail:display')
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue(dated())
  })

  it('lists released and upcoming together by default', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['out', 'soon', 'tba'])
    wrapper.unmount()
  })

  it('leaves an undated work alone whichever release switch is off', async () => {
    // A work with no date is evidence of neither, and dropping it would swallow every
    // unannounced book in the catalog.
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.setDisplay({ ...composable.display.value, upcoming: false })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['out', 'tba'])

    composable.setDisplay({ ...composable.display.value, upcoming: true, released: false })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['soon', 'tba'])
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail group collapsing', () => {
  const seriesDetail = (): MonitoredAuthorDetail => ({
    author: detail().author,
    works: [
      work({ id: 'first', title: 'First', seriesName: 'A Series', seriesMemberships: [{ name: 'A Series', index: '1' }] }),
      work({ id: 'alone', title: 'Alone' }),
    ],
  })

  beforeEach(() => {
    routeState.authorId = 'author-1'
    storage.remove('monitored:authorDetail:collapsed')
    storage.remove('monitored:authorDetail:group')
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue(seriesDetail())
  })

  it('starts expanded and collapses one section without touching the others', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.groups.value.map((group) => group.key)).toEqual(['A Series', 'standalone'])
    expect(composable.allGroupsCollapsed.value).toBe(false)

    composable.toggleGroup('A Series')

    expect(composable.isGroupCollapsed('A Series')).toBe(true)
    expect(composable.isGroupCollapsed('standalone')).toBe(false)
    wrapper.unmount()
  })

  it('collapses and expands every section from the one toggle', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.toggleAllGroups()
    expect(composable.allGroupsCollapsed.value).toBe(true)

    composable.toggleAllGroups()
    expect(composable.isGroupCollapsed('A Series')).toBe(false)
    expect(composable.allGroupsCollapsed.value).toBe(false)
    wrapper.unmount()
  })

  it('finds the same sections collapsed on a later visit to that author', async () => {
    const first = mountComposable()
    await first.composable.load()
    first.composable.toggleGroup('A Series')
    first.wrapper.unmount()

    const revisit = mountComposable()
    await revisit.composable.load()

    expect(revisit.composable.isGroupCollapsed('A Series')).toBe(true)
    expect(revisit.composable.isGroupCollapsed('standalone')).toBe(false)
    revisit.wrapper.unmount()
  })

  it('remembers each author separately, so collapsing one leaves the next as it was', async () => {
    const first = mountComposable()
    await first.composable.load()
    first.composable.toggleAllGroups()
    first.wrapper.unmount()

    routeState.authorId = 'author-2'
    const second = mountComposable()
    await second.composable.load()

    expect(second.composable.allGroupsCollapsed.value).toBe(false)
    expect(storage.get<Record<string, unknown>>('monitored:authorDetail:collapsed', {})).toEqual({ 'author-1': { all: true, groups: {} } })
    second.wrapper.unmount()
  })

  it('keeps what another open author page has remembered, since several stay mounted at once', async () => {
    const first = mountComposable()
    await first.composable.load()
    first.composable.toggleGroup('A Series')

    routeState.authorId = 'author-2'
    const second = mountComposable()
    await second.composable.load()
    second.composable.toggleAllGroups()

    // The first page is still mounted, so its next write must not roll the second one back.
    routeState.authorId = 'author-1'
    first.composable.toggleGroup('standalone')

    expect(storage.get<Record<string, unknown>>('monitored:authorDetail:collapsed', {})).toEqual({
      'author-1': { all: false, groups: { 'series:A Series': true, 'series:standalone': true } },
      'author-2': { all: true, groups: {} },
    })
    first.wrapper.unmount()
    second.wrapper.unmount()
  })

  it("keeps each grouping's sections apart, since the same name means something else under another", async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.toggleGroup('A Series')
    composable.setGrouping('year')

    // A year section named like the collapsed series must not inherit its state.
    expect(composable.isGroupCollapsed('A Series')).toBe(false)

    composable.setGrouping('series')
    expect(composable.isGroupCollapsed('A Series')).toBe(true)
    wrapper.unmount()
  })

  it("lets a section named after a member of the record's prototype be opened again", async () => {
    // Series names are provider data: 'toString' read straight off the record would come back as a
    // function, which is not nullish, and the section could never be opened.
    fetchDetailMock.mockResolvedValue({
      author: detail().author,
      works: [work({ id: 'odd', title: 'Odd', seriesName: 'toString', seriesMemberships: [{ name: 'toString', index: '1' }] })],
    })
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.isGroupCollapsed('toString')).toBe(false)

    composable.toggleGroup('toString')
    expect(composable.isGroupCollapsed('toString')).toBe(true)

    composable.toggleGroup('toString')
    expect(composable.isGroupCollapsed('toString')).toBe(false)
    wrapper.unmount()
  })
})
