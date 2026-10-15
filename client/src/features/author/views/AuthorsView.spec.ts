import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { AuthorSummary, MonitoredAuthorSearchResult } from '@bookorbit/types'
import type { AuthorListSort, SortDirection } from '../types/author'
import AuthorsView from './AuthorsView.vue'
import AuthorFilterChips from '../components/AuthorFilterChips.vue'
import AuthorTile from '../components/AuthorTile.vue'
import MonitorAuthorModal from '@/features/monitored/components/MonitorAuthorModal.vue'

class MockIntersectionObserver {
  observe = vi.fn<(target: Element) => void>()
  unobserve = vi.fn<(target: Element) => void>()
  disconnect = vi.fn<() => void>()
  takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => [])
}

function author(id: number, name: string, extra: Partial<AuthorSummary> = {}): AuthorSummary {
  return { id, name, sortName: null, bookCount: 1, lastAddedAt: null, coverBookId: null, ...extra }
}

function searchResult(extra: Partial<MonitoredAuthorSearchResult> = {}): MonitoredAuthorSearchResult {
  return {
    name: 'Blake Crouch',
    providerIds: { hardcover: 'hc-1' },
    localAuthorId: null,
    bookCount: 12,
    imageUrl: null,
    genres: [],
    alreadyMonitoredId: null,
    ...extra,
  }
}

const mocks = vi.hoisted(() => ({
  route: { params: {} as Record<string, string>, query: {} as Record<string, unknown>, fullPath: '/authors' },
  routerPush: vi.fn<(to: unknown) => Promise<void>>(),
  routerReplace: vi.fn<(to: unknown) => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  load: vi.fn<(reset?: boolean) => Promise<void>>(),
  loadThrough: vi.fn<(index: number) => Promise<boolean>>(),
  items: null as unknown as { value: AuthorSummary[] },
  q: null as unknown as { value: string },
  sort: null as unknown as { value: AuthorListSort },
  order: null as unknown as { value: SortDirection },
  libraryId: null as unknown as { value: number | null },
  hasPhoto: null as unknown as { value: boolean | null },
  hasSortName: null as unknown as { value: boolean | null },
  addedWithinDays: null as unknown as { value: number | null },
  minBookCount: null as unknown as { value: number | null },
  viewMode: null as unknown as { value: string },
  searchMonitoredAuthors: vi.fn<(query: string) => Promise<MonitoredAuthorSearchResult[]>>(),
  selectionMode: null as unknown as { value: boolean },
  selectedIds: null as unknown as { value: Set<number> },
  selectedCount: null as unknown as { value: number },
  bulkRefresh:
    vi.fn<
      (ids: number[], onProgress?: unknown, options?: { ignoreCache?: boolean }) => Promise<{ processed: number; failed: number; updated: number }>
    >(),
}))

vi.mock('@/features/monitored/api/monitored', () => ({
  searchMonitoredAuthors: mocks.searchMonitoredAuthors,
  monitorAuthor: vi.fn<() => Promise<never>>(),
}))

vi.mock('../api/author', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/author')>()),
  bulkRefreshAuthorsMetadata: mocks.bulkRefresh,
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    warning: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
  },
}))

vi.mock('@/composables/useDisplaySettings', () => ({
  useDisplaySettings: () => ({
    gridGap: ref(16),
    viewMode: mocks.viewMode,
    authorCoverSize: ref(120),
    authorCoverShape: ref('circle'),
    authorRowDensity: ref('comfortable'),
    authorCoverFallback: ref(false),
    showJumpRails: ref(true),
  }),
}))

vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: mocks.fetchLibraries }),
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => true, isDemoRestrictedAccount: ref(false), isSuperuser: ref(false) }),
}))

vi.mock('../composables/useAuthorJumpRail', () => ({
  useAuthorJumpRail: () => ({
    buckets: ref([]),
    visible: ref(false),
    template: ref([]),
    activeKey: ref(null),
    gutterReserved: ref(false),
    releaseGutter: vi.fn<() => void>(),
    syncActiveKey: vi.fn<() => void>(),
    handleJump: vi.fn<() => Promise<void>>(),
  }),
}))

vi.mock('../composables/useAuthorsList', () => ({
  useAuthorsList: () => ({
    items: mocks.items,
    total: ref(0),
    loading: ref(false),
    error: ref(null),
    hasMore: ref(false),
    q: mocks.q,
    sort: mocks.sort,
    order: mocks.order,
    libraryId: mocks.libraryId,
    hasPhoto: mocks.hasPhoto,
    hasSortName: mocks.hasSortName,
    addedWithinDays: mocks.addedWithinDays,
    minBookCount: mocks.minBookCount,
    filterParams: () => ({}),
    load: mocks.load,
    loadThrough: mocks.loadThrough,
  }),
}))

vi.mock('../composables/useAuthorSelection', () => ({
  useAuthorSelection: () => ({
    selectionMode: mocks.selectionMode,
    selectedIds: mocks.selectedIds,
    selectedCount: mocks.selectedCount,
    enterSelectionMode: vi.fn<() => void>(),
    exitSelectionMode: vi.fn<() => void>(),
    toggleAuthor: vi.fn<(id: number) => void>(),
    rangeSelectTo: vi.fn<(id: number, ids: number[]) => void>(),
    selectAll: vi.fn<(ids: number[]) => void>(),
    isSelected: () => false,
  }),
}))

vi.mock('../composables/useRefreshingAuthors', () => ({
  useRefreshingAuthors: () => ({
    markRefreshing: vi.fn<(id: number) => void>(),
    clearRefreshing: vi.fn<(id: number) => void>(),
    isRefreshing: () => false,
  }),
}))

async function mountView() {
  const wrapper = shallowMount(AuthorsView)
  await flushPromises()
  return wrapper
}

describe('AuthorsView', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    mocks.route.query = {}
    mocks.routerPush.mockResolvedValue()
    mocks.routerReplace.mockResolvedValue()
    mocks.fetchLibraries.mockResolvedValue()
    mocks.load.mockResolvedValue()
    mocks.loadThrough.mockResolvedValue(true)
    mocks.items = ref([])
    mocks.q = ref('')
    mocks.sort = ref('name')
    mocks.order = ref('asc')
    mocks.libraryId = ref(null)
    mocks.hasPhoto = ref(null)
    mocks.hasSortName = ref(null)
    mocks.addedWithinDays = ref(null)
    mocks.minBookCount = ref(null)
    mocks.viewMode = ref('list')
    mocks.searchMonitoredAuthors.mockResolvedValue([])
    mocks.selectionMode = ref(false)
    mocks.selectedIds = ref(new Set<number>())
    mocks.selectedCount = ref(0)
    mocks.bulkRefresh.mockResolvedValue({ processed: 2, failed: 0, updated: 2 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the filter chips outside the scrolling <main> so they stay anchored', async () => {
    const wrapper = await mountView()

    expect(wrapper.find('main').exists()).toBe(true)
    const chips = wrapper.findComponent(AuthorFilterChips)
    expect(chips.exists()).toBe(true)
    // Regression guard for #326: filters must NOT live inside the scroll container.
    expect(chips.element.closest('main')).toBeNull()
  })

  it('hydrates a quick filter from the route into the matching list filters', async () => {
    mocks.route.query = { filter: 'noPortrait' }
    await mountView()

    expect(mocks.hasPhoto.value).toBe(false)
    expect(mocks.minBookCount.value).toBeNull()
    expect(mocks.addedWithinDays.value).toBeNull()
    expect(mocks.hasSortName.value).toBeNull()
  })

  it('treats the quick filters as mutually exclusive', async () => {
    mocks.route.query = { filter: 'multipleBooks' }
    const wrapper = await mountView()

    expect(mocks.minBookCount.value).toBe(2)

    wrapper.findComponent(AuthorFilterChips).vm.$emit('update:quickFilter', 'recentlyAdded')
    await flushPromises()

    expect(mocks.minBookCount.value).toBeNull()
    expect(mocks.addedWithinDays.value).toBe(7)
  })

  it('groups authors into one section per letter when sorted alphabetically', async () => {
    mocks.items = ref([author(1, 'Alan Glynn'), author(2, 'Amy Tan'), author(3, 'Blake Crouch')])
    const wrapper = await mountView()

    const headings = wrapper.findAll('[data-letter]')
    expect(headings.map((heading) => heading.attributes('data-letter'))).toEqual(['A', 'B'])
  })

  it('drops the letter sections when the sort is not alphabetical', async () => {
    mocks.items = ref([author(1, 'Alan Glynn'), author(2, 'Blake Crouch')])
    // The view hydrates sort from the route on mount, so drive it from there.
    mocks.route.query = { sort: 'bookCount' }
    const wrapper = await mountView()

    expect(wrapper.findAll('[data-letter]')).toHaveLength(0)
  })

  describe('monitoring an author from the kebab menu', () => {
    async function mountGalleryAndMonitor() {
      mocks.items = ref([author(7, 'Blake Crouch')])
      mocks.viewMode = ref('grid')
      const wrapper = await mountView()

      wrapper.findComponent(AuthorTile).vm.$emit('monitor', 7)
      await flushPromises()
      return wrapper
    }

    it('opens the modal with the search result that maps to the local author', async () => {
      const match = searchResult({ localAuthorId: 7 })
      mocks.searchMonitoredAuthors.mockResolvedValue([searchResult({ name: 'Someone Else', localAuthorId: 9 }), match])

      const modal = (await mountGalleryAndMonitor()).findComponent(MonitorAuthorModal)

      expect(mocks.searchMonitoredAuthors).toHaveBeenCalledWith('Blake Crouch')
      expect(modal.props('open')).toBe(true)
      expect(modal.props('result')).toEqual(match)
    })

    it('says so and stays closed when the author is already monitored', async () => {
      mocks.searchMonitoredAuthors.mockResolvedValue([searchResult({ localAuthorId: 7, alreadyMonitoredId: 'mon-1' })])

      const modal = (await mountGalleryAndMonitor()).findComponent(MonitorAuthorModal)

      expect(toast.info).toHaveBeenCalledWith('Blake Crouch is already on your watchlist')
      expect(modal.props('open')).toBe(false)
      expect(modal.props('result')).toBeNull()
    })

    it('falls back to the local author when the search matches nothing', async () => {
      mocks.searchMonitoredAuthors.mockResolvedValue([searchResult({ name: 'Someone Else', localAuthorId: 9 })])

      const modal = (await mountGalleryAndMonitor()).findComponent(MonitorAuthorModal)

      expect(modal.props('open')).toBe(true)
      expect(modal.props('result')).toEqual({
        name: 'Blake Crouch',
        providerIds: {},
        localAuthorId: 7,
        bookCount: 1,
        imageUrl: null,
        genres: [],
        alreadyMonitoredId: null,
      })
    })

    it('refuses to bind a same-name result that already belongs to another local author', async () => {
      mocks.searchMonitoredAuthors.mockResolvedValue([searchResult({ name: 'Blake Crouch', localAuthorId: 9 })])

      const modal = (await mountGalleryAndMonitor()).findComponent(MonitorAuthorModal)

      expect(modal.props('open')).toBe(true)
      expect(modal.props('result')).toEqual({
        name: 'Blake Crouch',
        providerIds: {},
        localAuthorId: 7,
        bookCount: 1,
        imageUrl: null,
        genres: [],
        alreadyMonitoredId: null,
      })
    })

    it('reports a failed search and releases the tile', async () => {
      mocks.searchMonitoredAuthors.mockRejectedValue(new Error('network down'))

      const wrapper = await mountGalleryAndMonitor()

      expect(toast.error).toHaveBeenCalledWith('Failed to search authors.')
      expect(wrapper.findComponent(MonitorAuthorModal).props('open')).toBe(false)
      expect(wrapper.findComponent(AuthorTile).props('monitoring')).toBe(false)
    })
  })

  describe('bulk metadata refresh', () => {
    const passthrough = { template: '<div><slot /></div>' }

    async function mountSelecting() {
      mocks.selectionMode.value = true
      mocks.selectedIds.value = new Set([4, 9])
      mocks.selectedCount.value = 2
      const wrapper = shallowMount(AuthorsView, {
        global: {
          stubs: {
            SelectionActionBar: { template: '<div><slot name="content" /></div>' },
            Tooltip: passthrough,
            TooltipTrigger: passthrough,
            TooltipContent: passthrough,
            IgnoreCacheCheckbox: false,
          },
        },
      })
      await flushPromises()
      return wrapper
    }

    it('asks for confirmation and keeps cached results unless told to ignore them', async () => {
      const wrapper = await mountSelecting()

      await wrapper.get('[data-testid="author-bulk-refresh"]').trigger('click')
      expect(mocks.bulkRefresh).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="author-bulk-refresh-confirm"]').exists()).toBe(true)

      await wrapper.get('[data-testid="author-bulk-refresh-confirm-action"]').trigger('click')
      await flushPromises()

      expect(mocks.bulkRefresh).toHaveBeenCalledWith([4, 9], expect.any(Function), { ignoreCache: false })
    })

    it('ignores cached results when the box is checked', async () => {
      const wrapper = await mountSelecting()

      await wrapper.get('[data-testid="author-bulk-refresh"]').trigger('click')
      await wrapper.get('[data-testid="ignore-cache-checkbox"]').setValue(true)
      await wrapper.get('[data-testid="author-bulk-refresh-confirm-action"]').trigger('click')
      await flushPromises()

      expect(mocks.bulkRefresh).toHaveBeenCalledWith([4, 9], expect.any(Function), { ignoreCache: true })
    })
  })
})
