import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import { mount, shallowMount, flushPromises } from '@vue/test-utils'
import type { MonitoredAuthorDetail, MonitoredWork } from '@bookorbit/types'
import { fetchMonitoredAuthorDetail, refreshMonitoredAuthor, requestMonitoredWork, updateMonitoredWork } from '../api/monitored'
import { storage } from '@/services/storage'
import { defaultAuthorStatusFilters } from '../lib/status-filter'
import { useMonitoredAuthorDetail } from './useMonitoredAuthorDetail'
import MonitoredAuthorDetailView from '../views/MonitoredAuthorDetailView.vue'

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => false }),
}))
vi.mock('@/features/book-requests/composables/useBookRequestProgress', () => ({
  useBookRequestProgress: () => ({ onRequestsChanged: () => () => {} }),
}))

const routeState = vi.hoisted(() => ({
  authorId: 'author-1',
  name: 'monitored-author',
  query: {} as Record<string, string>,
  replace: vi.fn<(location: unknown) => Promise<void>>(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({
    name: routeState.name,
    params: { id: routeState.authorId },
    get query() {
      return routeState.query
    },
  }),
  useRouter: () => ({ replace: routeState.replace }),
}))

vi.mock('../api/monitored', () => ({
  fetchMonitoredAuthorDetail: vi.fn<() => Promise<MonitoredAuthorDetail>>(),
  refreshMonitoredAuthor: vi.fn<() => Promise<MonitoredAuthorDetail['author']>>(),
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
      fetch: { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
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
    storage.remove('monitored:authorDetail:display:v3')
    fetchDetailMock.mockReset()
    requestWorkMock.mockReset()
    refreshMock.mockReset()
    updateWorkMock.mockReset()
    fetchDetailMock.mockResolvedValue(detail())
    routeState.name = 'monitored-author'
    routeState.query = {}
    routeState.replace.mockReset()
  })

  it('defaults the status filter to every status except hidden, and sends no status query', async () => {
    storage.remove('monitored:authorDetail:status:v2')
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.statusFilters.value).toEqual(['missing', 'needs_attention', 'upcoming', 'in_library', 'not_watched'])
    expect(fetchDetailMock).toHaveBeenCalledWith('author-1', { sort: 'releaseDate', order: 'desc', includeHidden: true })
    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('ignores a selection stored under the old key', () => {
    storage.set('monitored:authorDetail:status', ['missing'])
    const { composable, wrapper } = mountComposable()

    expect(composable.statusFilters.value).toContain('in_library')
    storage.remove('monitored:authorDetail:status')
    wrapper.unmount()
  })

  it('keeps the catalog while a background refresh is queued', async () => {
    const filtered = detail()
    fetchDetailMock.mockResolvedValue(filtered)
    refreshMock.mockResolvedValue({ ...filtered.author, fetch: { ...filtered.author.fetch, state: 'queued' } })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    const before = composable.detail.value?.works.map((entry) => entry.id)
    fetchDetailMock.mockClear()

    await composable.refreshAuthor()

    expect(refreshMock).toHaveBeenCalledWith('author-1')
    expect(fetchDetailMock).not.toHaveBeenCalled()
    expect(composable.fetchStatus.value.state).toBe('queued')
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

  it('shows a work hidden on this page once the Hidden filter is on, without a refetch', async () => {
    updateWorkMock.mockResolvedValue(work({ userVisibility: 'hidden' }))
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.updateWork('work-1', { hidden: true })
    expect(composable.visibleWorks.value).toHaveLength(0)
    expect(composable.filterCounts.value.hidden).toBe(1)
    fetchDetailMock.mockClear()

    composable.setDisplay({ ...composable.display.value, hidden: true })

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1'])
    expect(fetchDetailMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('trusts a fresh load over a hide recorded earlier on the page', async () => {
    updateWorkMock.mockResolvedValue(work({ userVisibility: 'hidden' }))
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.updateWork('work-1', { hidden: true })
    expect(composable.visibleWorks.value).toHaveLength(0)

    fetchDetailMock.mockResolvedValue(detail())
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1'])
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
    storage.remove('monitored:authorDetail:display:v3')
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue(reviewDetail())
  })

  it('counts every loaded class and filters locally without reloading', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1'])
    expect(composable.filterCounts.value).toMatchObject({
      hidden: 1,
      placeholder: 1,
      unconfirmed: 3,
      kinds: { book: 1, collection: 1, graphic_novel: 1 },
    })
    fetchDetailMock.mockClear()
    composable.setDisplay({ ...composable.display.value, kinds: ['collection', 'graphic_novel'] })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['box-set', 'comic'])
    await composable.load()
    expect(composable.display.value.kinds).toEqual(['collection', 'graphic_novel'])
    fetchDetailMock.mockClear()
    composable.setDisplay({ ...composable.display.value, unconfirmed: true, hidden: true })
    expect(composable.visibleWorks.value).toHaveLength(4)
    expect(fetchDetailMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('persists section state independently of reset', () => {
    storage.remove('monitored:authorDetail:filterSections:v2')
    const { composable, wrapper } = mountComposable()
    expect(composable.filterSections.value).toEqual({ status: true, release: false, kind: false, more: false })
    composable.toggleFilterSection('more')
    composable.resetDisplay()
    expect(storage.get('monitored:authorDetail:filterSections:v2', null)).toEqual({ status: true, release: false, kind: false, more: true })
    storage.remove('monitored:authorDetail:filterSections:v2')
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail status filtering', () => {
  beforeEach(() => {
    storage.remove('monitored:authorDetail:status:v2')
    storage.remove('monitored:authorDetail:display:v3')
    fetchDetailMock.mockReset()
    fetchDetailMock.mockResolvedValue({
      author: detail().author,
      works: [
        work({ id: 'plain', title: 'Plain' }),
        work({ id: 'owned', title: 'Owned', ownedFormats: ['ebook'] }),
        work({ id: 'fetching', title: 'Fetching', requestStatuses: { ebook: 'downloading' } }),
      ],
    })
  })

  it('narrows the list on the client without reloading, and keeps the counts over the whole catalog', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['plain', 'owned', 'fetching'])
    const counts = composable.filterCounts.value
    fetchDetailMock.mockClear()

    composable.setStatusFilters(['in_library'])

    expect(fetchDetailMock).not.toHaveBeenCalled()
    expect(composable.filterCounts.value).toEqual(counts)
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['owned', 'fetching'])

    composable.setStatusFilters([])
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['fetching'])

    composable.setStatusFilters(defaultAuthorStatusFilters())
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['plain', 'owned', 'fetching'])
    wrapper.unmount()
  })

  it('reports whether the filters sit at the author default', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    expect(composable.filtersAreDefault.value).toBe(true)

    composable.setStatusFilters(['missing'])
    expect(composable.filtersAreDefault.value).toBe(false)

    composable.setStatusFilters(defaultAuthorStatusFilters())
    composable.setDisplay({ ...composable.display.value, hidden: true })
    expect(composable.filtersAreDefault.value).toBe(false)

    composable.resetDisplay()
    expect(composable.filtersAreDefault.value).toBe(true)
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
    storage.remove('monitored:authorDetail:display:v3')
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

describe('author detail empty filters', () => {
  beforeEach(() => {
    storage.remove('monitored:authorDetail:status:v2')
    storage.remove('monitored:authorDetail:display:v3')
    fetchDetailMock.mockReset()
  })

  it('renders an empty state and resets status and display filters', async () => {
    storage.set('monitored:authorDetail:display:v3', { kinds: [] })
    storage.set('monitored:authorDetail:status:v2', [])
    fetchDetailMock.mockResolvedValue(detail())
    const wrapper = shallowMount(MonitoredAuthorDetailView, { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="filters-empty"]').text()).toContain('No books match these filters')
    expect(fetchDetailMock).toHaveBeenLastCalledWith('author-1', { sort: 'releaseDate', order: 'desc', includeHidden: true })
    await wrapper.get('[data-testid="filters-empty"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="filters-empty"]').exists()).toBe(false)
    expect(storage.get('monitored:authorDetail:status:v2', null)).toEqual(['missing', 'needs_attention', 'upcoming', 'in_library', 'not_watched'])
    expect(storage.get('monitored:authorDetail:display:v3', null)).toMatchObject({ kinds: ['book'] })
    wrapper.unmount()
    storage.remove('monitored:authorDetail:status:v2')
    storage.remove('monitored:authorDetail:display:v3')
  })

  it('renders no empty state for a catalog with no works at all', async () => {
    fetchDetailMock.mockResolvedValue({ ...detail(), works: [] })
    const wrapper = shallowMount(MonitoredAuthorDetailView, { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="filters-empty"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders no empty state while the filters sit at their default', async () => {
    fetchDetailMock.mockResolvedValue({ ...detail(), works: [work({ userVisibility: 'hidden' })] })
    const wrapper = shallowMount(MonitoredAuthorDetailView, { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="filters-empty"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail local search', () => {
  beforeEach(() => {
    routeState.query = {}
    storage.remove('monitored:authorDetail:display:v3')
    storage.remove('monitored:authorDetail:status:v2')
    fetchDetailMock.mockResolvedValue({
      ...detail(),
      works: [
        work({ id: 'title', title: 'Les Misérables' }),
        work({ id: 'subtitle', subtitle: 'A French Story' }),
        work({ id: 'series', seriesName: 'The Saga' }),
        work({ id: 'membership', seriesMemberships: [{ name: 'Shared Universe', index: '1' }] }),
        work({ id: 'hidden', title: 'Les Misérables hidden', userVisibility: 'hidden' }),
      ],
    })
  })

  it.each([
    ['  LES MISERABLES ', 'title'],
    ['french', 'subtitle'],
    ['saga', 'series'],
    ['universe', 'membership'],
  ])('matches %s locally', async (query, id) => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    composable.setSearchQuery(query)
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual([id])
    expect(composable.filtersAreDefault.value).toBe(false)
    composable.setSearchQuery('')
    expect(composable.visibleWorks.value).toHaveLength(4)
    wrapper.unmount()
  })

  it('folds undecomposed letters with the upstream search helper', async () => {
    fetchDetailMock.mockResolvedValue({ ...detail(), works: [work({ title: 'Œuvre' })] })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    composable.setSearchQuery('oe')
    expect(composable.visibleWorks.value.map((entry) => entry.title)).toEqual(['Œuvre'])
    wrapper.unmount()
  })

  it('restores the route search when a kept-alive instance is reactivated', async () => {
    routeState.query = { q: 'saga' }
    const active = ref(true)
    let composable!: ReturnType<typeof useMonitoredAuthorDetail>
    const Page = defineComponent({
      setup() {
        composable = useMonitoredAuthorDetail()
        return () => h('div')
      },
    })
    const wrapper = mount(
      defineComponent({
        setup: () => () => h(KeepAlive, null, { default: () => (active.value ? h(Page) : null) }),
      }),
    )
    const original = composable
    expect(composable.searchQuery.value).toBe('saga')
    for (const query of [{}, { q: 'universe' }] as Array<Record<string, string>>) {
      active.value = false
      await nextTick()
      routeState.query = query
      active.value = true
      await nextTick()
      expect(composable).toBe(original)
      expect(composable.searchQuery.value).toBe(query.q ?? '')
      composable.setSort('title')
      expect(routeState.replace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ q: query.q }),
        }),
      )
      composable.setSort('releaseDate')
    }
    wrapper.unmount()
  })

  it('combines search with display filters and resets both', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    composable.setSearchQuery('miserables')
    composable.setDisplay({ ...composable.display.value, hidden: true })
    expect(composable.visibleWorks.value).toHaveLength(2)
    composable.resetDisplay()
    expect(composable.searchQuery.value).toBe('')
    expect(composable.filtersAreDefault.value).toBe(true)
    expect(composable.visibleWorks.value).toHaveLength(4)
    wrapper.unmount()
  })

  it('reads q on arrival, writes changes and omits an empty query', () => {
    routeState.query = { q: 'saga' }
    const { composable, wrapper } = mountComposable()
    expect(composable.searchQuery.value).toBe('saga')
    composable.setSearchQuery('universe')
    expect(routeState.replace).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ q: 'universe' }) }))
    routeState.query = { q: 'universe' }
    const revisit = mountComposable()
    expect(revisit.composable.searchQuery.value).toBe('universe')
    composable.setSearchQuery('')
    expect(routeState.replace).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ q: undefined }) }))
    revisit.wrapper.unmount()
    wrapper.unmount()
    routeState.query = {}
  })
})
