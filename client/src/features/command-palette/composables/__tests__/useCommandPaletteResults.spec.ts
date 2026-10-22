import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { fetchCapabilities, suggestSerials, discoverSerials } from '@/features/web-serials/api/webSerials'
import type { searchCatalogWorks, searchHardcoverUniversal } from '@/features/monitored/api/monitored'
import { Permission } from '@bookorbit/types'
import { catalogEntry, suggestion } from '@/features/web-serials/__tests__/fixtures'
import { workFixture } from '@/features/monitored/testing/work-fixture'
import type {
  AuthorSummary,
  BookCard,
  HardcoverSearchBook,
  HardcoverUniversalSearchResult,
  MonitoredAuthorSearchResult,
  MonitoredCatalogSearchHit,
  SeriesSummary,
} from '@bookorbit/types'
import { useCommandPaletteResults, type PaletteTab } from '../useCommandPaletteResults'

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn<typeof fetchCapabilities>(),
  suggest: vi.fn<typeof suggestSerials>(),
  discover: vi.fn<typeof discoverSerials>(),
  catalog: vi.fn<typeof searchCatalogWorks>(),
  hardcover: vi.fn<typeof searchHardcoverUniversal>(),
  permissions: new Set<string>(),
  books: null as unknown as import('vue').Ref<BookCard[]>,
  bookTotal: null as unknown as import('vue').Ref<number>,
  fetchAuthors: vi.fn<(params: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(params: unknown) => Promise<unknown>>(),
  api: vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(),
  toggleTheme: vi.fn<() => void>(),
}))

vi.mock('@/features/web-serials/api/webSerials', () => ({
  fetchCapabilities: mocks.capabilities,
  suggestSerials: mocks.suggest,
  discoverSerials: mocks.discover,
}))

vi.mock('@/features/monitored/api/monitored', () => ({ searchCatalogWorks: mocks.catalog, searchHardcoverUniversal: mocks.hardcover }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { count?: number }) => (params?.count != null ? `${key}:${params.count}` : key) }),
}))

vi.mock('@/lib/api', () => ({ api: mocks.api }))

vi.mock('@/composables/useSidebarNav', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useSidebarNav: () => ({
      zones: vueRef([
        {
          id: 'primary',
          entries: [{ id: 'dashboard', label: 'Dashboard', icon: {}, to: { name: 'dashboard' }, isActive: false, badge: null }],
        },
        {
          id: 'reading',
          entries: [{ id: 'statistics', label: 'Statistics', icon: {}, to: { name: 'statistics' }, isActive: false, badge: null }],
        },
      ]),
    }),
  }
})

vi.mock('@/composables/useSidebarSections', () => ({
  SIDEBAR_SECTIONS: [
    { kind: 'library', medium: 'books', icon: {}, routeName: 'library' },
    { kind: 'smartScope', medium: 'books', icon: {}, routeName: 'smartScope' },
    { kind: 'collection', medium: 'books', icon: {}, routeName: 'collection' },
    { kind: 'library', medium: 'podcasts', icon: {}, routeName: 'podcast-library' },
  ],
}))

vi.mock('@/features/library/composables/useLibraries', async () => {
  const { ref: vueRef } = await import('vue')
  const libraries = vueRef([
    { id: 1, name: 'Novels', type: 'books', bookCount: 454 },
    { id: 2, name: 'Comics', type: 'books', bookCount: 10 },
    { id: 9, name: 'Shows', type: 'podcasts', bookCount: null },
  ])
  return { useLibraries: () => ({ libraries }) }
})

vi.mock('@/features/smart-scope/composables/useSmartScopes', async () => {
  const { ref: vueRef } = await import('vue')
  return { useSmartScopes: () => ({ bookScopes: vueRef([{ id: 2, name: 'Kobo', bookCount: 172 }]) }) }
})

vi.mock('@/features/collection/composables/useCollections', async () => {
  const { ref: vueRef } = await import('vue')
  return { useCollections: () => ({ bookCollections: vueRef([{ id: 8, name: 'Autumn Reads', bookCount: 2 }]) }) }
})

vi.mock('@/features/auth/composables/usePermissions', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    usePermissions: () => ({
      hasPermission: (name: string) => mocks.permissions.has(name),
      isSuperuser: vueRef(true),
      userPermissions: vueRef([]),
      isDemoRestrictedAccount: vueRef(false),
    }),
  }
})

const requestVisibility = vi.hoisted(() => ({ showBookRequests: { value: true } }))
vi.mock('@/features/book-requests/composables/useBookRequestVisibility', () => ({ useBookRequestVisibility: () => requestVisibility }))

vi.mock('@/features/book/composables/useGlobalSearch', async () => {
  const { computed, ref: vueRef } = await import('vue')
  return {
    useGlobalSearch: () => ({
      results: mocks.books,
      total: mocks.bookTotal,
      loading: vueRef(false),
      loadingMore: vueRef(false),
      settled: vueRef(true),
      hasMore: computed(() => mocks.books.value.length < mocks.bookTotal.value),
      loadMore: vi.fn<() => Promise<void>>(),
      clear: vi.fn<() => void>(),
    }),
  }
})

vi.mock('@/features/author/api/author', () => ({ fetchAuthors: mocks.fetchAuthors }))
vi.mock('@/features/series/api/series', () => ({ fetchSeries: mocks.fetchSeries }))
vi.mock('@/stores/theme', () => ({ useThemeStore: () => ({ resolvedTheme: 'dark', toggleTheme: mocks.toggleTheme }) }))

function capabilities(searchable = true): Awaited<ReturnType<typeof fetchCapabilities>> {
  return {
    manga: { available: searchable, searchable, defaultLibraryId: null, targetFolderId: null },
    novel: { available: searchable, searchable, acceptsLinks: searchable, defaultLibraryId: null, targetFolderId: null },
  }
}

function book(id: number, title: string): BookCard {
  return { id, title, authors: [], files: [], coverVersion: null } as unknown as BookCard
}

function setup(open = false) {
  const query = ref('')
  const tab = ref<PaletteTab>('all')
  const isOpen = ref(open)
  const handlers = { openUpload: vi.fn<() => void>(), navigate: vi.fn<(to: unknown) => void>() }
  const results = useCommandPaletteResults(query, tab, isOpen, handlers)
  return { query, tab, isOpen, handlers, ...results }
}

describe('useCommandPaletteResults', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.catalog.mockResolvedValue([])
    mocks.hardcover.mockResolvedValue({ available: true, books: [], authors: [] })
    mocks.capabilities.mockResolvedValue(capabilities())
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [] })
    mocks.discover.mockResolvedValue({ results: [], fallback: null })
    mocks.permissions.clear()
    mocks.books = ref([])
    mocks.bookTotal = ref(0)
    mocks.fetchAuthors.mockResolvedValue({ items: [], total: 0, page: 0, size: 20 })
    mocks.fetchSeries.mockResolvedValue({ items: [], total: 0, page: 0, size: 20 })
    mocks.api.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'command-palette', books: [book(827, 'The Ocean at the End of the Lane')], failed: false }] }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers Customize sidebar as an action that opens sidebar edit mode', async () => {
    const { useSidebarCustomizeMode } = await import('@/composables/useSidebarCustomizeMode')
    const { isCustomizing, stopCustomizing } = useSidebarCustomizeMode()
    stopCustomizing()
    const { sections } = setup()

    const action = sections.value.find((section) => section.id === 'actions')?.items.find((item) => item.key === 'action:customize-sidebar')
    expect(action?.kind === 'action' && action.label).toBe('components.sidebar.customize.open')
    if (action?.kind === 'action') action.run()

    expect(isCustomizing.value).toBe(true)
    stopCustomizing()
  })

  it('opens on continue reading, the book libraries and the actions', async () => {
    const { isOpen, sections } = setup()

    isOpen.value = true
    await nextTick()
    await vi.runAllTimersAsync()

    expect(sections.value.map((section) => section.id)).toEqual(['continue', 'goto', 'actions'])
    expect(sections.value[0]?.items.map((item) => item.key)).toEqual(['reading:827'])
    expect(sections.value[1]?.items.map((item) => item.key)).toEqual(['library:1', 'library:2'])
  })

  it('offers Upload only to users who may upload', () => {
    const withoutPermission = setup().sections.value.find((section) => section.id === 'actions')
    expect(withoutPermission?.items.map((item) => item.key)).not.toContain('action:upload')

    mocks.permissions.add('library_upload')
    const withPermission = setup().sections.value.find((section) => section.id === 'actions')
    expect(withPermission?.items[0]?.key).toBe('action:upload')
  })

  it('ranks title matches first, caps books at five and links to the full list', async () => {
    const { query, sections } = setup()
    mocks.books.value = [
      book(1, 'Bad Bishop'),
      book(2, 'Carrie'),
      book(3, 'King of Ashes'),
      book(4, 'King Sorrow'),
      book(5, 'The Kingdom of Copper'),
      book(6, 'This Kingdom Will Not Kill Me'),
    ]
    mocks.bookTotal.value = 15

    query.value = 'king'
    await nextTick()

    const books = sections.value.find((section) => section.id === 'books')
    expect(books?.count).toBe(15)
    expect(books?.items.map((item) => item.key)).toEqual(['book:3', 'book:4', 'book:5', 'book:6', 'book:1', 'more:books'])
  })

  it('loads authors and series after the debounce and folds the extras behind a link', async () => {
    const authors = [1, 2, 3, 4].map((id) => ({ id, name: `King ${id}`, bookCount: 1 }) as AuthorSummary)
    mocks.fetchAuthors.mockResolvedValue({ items: authors, total: 4, page: 0, size: 20 })
    mocks.fetchSeries.mockResolvedValue({ items: [{ id: 7, name: 'The Shepherd King' } as SeriesSummary], total: 1, page: 0, size: 20 })
    const { query, sections, tabs } = setup()

    query.value = 'king'
    await nextTick()
    expect(mocks.fetchAuthors).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    expect(mocks.fetchAuthors).toHaveBeenCalledWith({ q: 'king', page: 0, size: 20, sort: 'name', order: 'asc' })
    const authorSection = sections.value.find((section) => section.id === 'authors')
    expect(authorSection?.items.map((item) => item.key)).toEqual(['author:1', 'author:2', 'author:3', 'more:authors'])
    expect(tabs.value.map((option) => [option.id, option.count])).toEqual([
      ['all', 5],
      ['authors', 4],
      ['series', 1],
    ])
  })

  it('shows only the chosen kind on a tab', async () => {
    const { query, tab, sections } = setup()
    mocks.books.value = [book(1, 'King Sorrow'), book(2, 'Bad Bishop')]
    mocks.bookTotal.value = 2

    query.value = 'king'
    tab.value = 'books'
    await nextTick()

    expect(sections.value).toHaveLength(1)
    expect(sections.value[0]?.items.map((item) => item.key)).toEqual(['book:1', 'book:2'])
  })

  it('finds places by name and settings pages by keyword', async () => {
    const { query, sections } = setup()

    query.value = 'kobo'
    await nextTick()

    expect(sections.value.find((section) => section.id === 'goto')?.items.map((item) => item.key)).toEqual(['smartScope:2'])
    expect(sections.value.find((section) => section.id === 'settings')?.items.map((item) => item.key)).toContain('setting:kobo')
  })

  it('switches the theme through the action', () => {
    const { sections } = setup()
    const theme = sections.value.find((section) => section.id === 'actions')?.items.find((item) => item.key === 'action:theme')

    expect(theme?.kind).toBe('action')
    if (theme?.kind === 'action') theme.run()
    expect(mocks.toggleTheme).toHaveBeenCalledOnce()
  })
  it('does not call universal search without permission', async () => {
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(mocks.catalog).not.toHaveBeenCalled()
    expect(mocks.hardcover).not.toHaveBeenCalled()
  })

  it('waits for both local searches and 500 ms before searching thin results', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    let finish!: (value: MonitoredCatalogSearchHit[]) => void
    mocks.catalog.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final Empire')]
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.hardcover).not.toHaveBeenCalled()
    finish([])
    await vi.advanceTimersByTimeAsync(499)
    expect(mocks.hardcover).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.hardcover).toHaveBeenCalledOnce()
  })

  it('offers manual search with three distinct strong books and runs it once', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')]
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).not.toHaveBeenCalled()
    expect(state.sections.value.flatMap((s) => s.items).some((i) => i.kind === 'externalSearch')).toBe(true)
    state.activate({ kind: 'externalSearch', key: 'externalSearch', label: 'Search', providers: ['hardcover'] })
    await vi.runAllTimersAsync()
    state.activate({ kind: 'externalSearch', key: 'externalSearch', label: 'Search', providers: ['hardcover'] })
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
  })

  it('aborts on a keystroke and hides unavailable Hardcover for the session', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockReturnValueOnce(new Promise(() => {}))
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    const signal = mocks.hardcover.mock.calls[0]?.[1] as AbortSignal
    state.query.value = 'empire'
    await nextTick()
    expect(signal.aborted).toBe(true)
    mocks.hardcover.mockResolvedValue({ available: false, books: [], authors: [] })
    await vi.runAllTimersAsync()
    expect(state.tabs.value.some((t) => t.id === 'hardcover')).toBe(false)
    expect(state.sections.value.flatMap((s) => s.items).some((i) => i.kind === 'externalSearch')).toBe(false)
  })

  it('keeps Hardcover for the next query after an available empty answer', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockResolvedValueOnce({ available: true, books: [], authors: [] })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    mocks.hardcover.mockResolvedValue({ available: true, books: [], authors: [] })
    state.query.value = 'empire'
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledTimes(2)
  })

  it('drops Hardcover books but keeps Hardcover authors when Requests is hidden', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    requestVisibility.showBookRequests.value = false
    mocks.hardcover.mockResolvedValue({
      available: true,
      books: [{ slug: 'b', title: 'Final Book', authorNames: ['A'], seriesName: null, coverUrl: null }],
      authors: [
        {
          name: 'Final Author',
          providerIds: { hardcover: '1' },
          localAuthorId: null,
          bookCount: 3,
          imageUrl: null,
          genres: [],
          alreadyMonitoredId: null,
        },
      ],
    })
    try {
      const state = setup()
      state.isOpen.value = true
      state.query.value = 'final'
      await vi.runAllTimersAsync()
      const kinds = state.sections.value.flatMap((s) => s.items).map((i) => i.kind)
      expect(kinds).not.toContain('hardcoverBook')
      expect(kinds).toContain('hardcoverAuthor')
      expect(state.tabs.value.find((t) => t.id === 'hardcover')?.count).toBe(1)
    } finally {
      requestVisibility.showBookRequests.value = true
    }
  })

  it('ranks manga by title match under the library, keeping non-matches last', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.discover.mockImplementation(async (_q, kind) =>
      kind === 'manga'
        ? {
            results: [
              catalogEntry({ matchId: '1', title: 'Eye of the Storm', kind: 'manga' }),
              catalogEntry({ matchId: '2', title: 'Loelline Seizes the Future', kind: 'manga' }),
              catalogEntry({ matchId: '3', title: 'Loen of the North', kind: 'manga' }),
            ],
            fallback: null,
          }
        : { results: [], fallback: null },
    )
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'loe'
    mocks.books.value = [book(1, 'Loe Library Book')]
    await vi.runAllTimersAsync()
    const ids = state.sections.value.map((section) => section.id)
    expect(ids.indexOf('books')).toBeLessThan(ids.indexOf('manga'))
    const manga = state.sections.value.find((section) => section.id === 'manga')!.items
    expect(manga.map((item) => (item.kind === 'manga' ? item.entry.title : ''))).toEqual([
      'Loelline Seizes the Future',
      'Loen of the North',
      'Eye of the Storm',
    ])
  })

  it('inserts universal sections after series and before places', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [suggestion()] })
    mocks.discover.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.catalog.mockResolvedValue([
      {
        work: workFixture({ id: 'w', title: 'Kobo', seriesName: null }),
        authorName: 'Someone',
        monitorAuthorId: 'a',
        authorModes: { ebook: 'notify', audiobook: 'off' },
      },
    ])
    mocks.hardcover.mockResolvedValue({
      available: true,
      books: [{ slug: 'b', title: 'Kobo' } as HardcoverSearchBook],
      authors: [{ name: 'Someone', providerIds: {} } as MonitoredAuthorSearchResult],
    })
    mocks.fetchAuthors.mockResolvedValue({ items: [{ id: 1, name: 'Kobo' }], total: 1 })
    mocks.fetchSeries.mockResolvedValue({ items: [{ id: 1, name: 'Kobo' }], total: 1 })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'kobo'
    mocks.books.value = [book(1, 'Kobo')]
    await vi.runAllTimersAsync()
    state.activate({ kind: 'externalSearch', key: 'externalSearch', label: 'Search', providers: ['hardcover'] })
    await vi.runAllTimersAsync()
    const ids = state.sections.value.map((s) => s.id)
    expect(ids.slice(0, 9)).toEqual(['books', 'authors', 'series', 'watchlist', 'lightNovels', 'manga', 'hardcoverBooks', 'hardcoverAuthors', 'goto'])
  })
  it('hides manual search during the automatic wait', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(250)
    expect(state.sections.value.flatMap((s) => s.items).some((i) => i.kind === 'externalSearch')).toBe(false)
  })
  it('shows skeleton rows for the whole automatic wait, not only once the request starts', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.hardcover).not.toHaveBeenCalled()
    expect(state.sections.value.flatMap((s) => s.items).some((i) => i.kind === 'skeleton')).toBe(true)
  })
  it('hides an empty Hardcover tab and returns to all', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await nextTick()
    state.tab.value = 'hardcover'
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    expect(state.tab.value).toBe('all')
    expect(state.tabs.value.some((t) => t.id === 'hardcover')).toBe(false)
  })
  it('cancels the scheduled call on a keystroke', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(300)
    state.query.value = 'empire'
    await vi.runAllTimersAsync()
    expect(mocks.hardcover.mock.calls.map((c) => c[0])).toEqual(['empire'])
  })
  it('activates the manual Hardcover row', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')]
    await vi.runAllTimersAsync()
    state.activate({ kind: 'externalSearch', key: 'externalSearch', label: 'Search', providers: ['hardcover'] })
    await nextTick()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
  })
  it('loads ten watchlist rows, caps All at three and aborts old queries', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.catalog.mockResolvedValue(
      Array.from(
        { length: 10 },
        (_, i) =>
          ({
            work: workFixture({ id: String(i), title: i === 0 ? 'The Final 2' : 'Final 3' }),
            authorName: 'A',
            authorModes: { ebook: 'notify', audiobook: 'off' },
            monitorAuthorId: 'a',
          }) as MonitoredCatalogSearchHit,
      ),
    )
    const state = setup()
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(mocks.catalog).toHaveBeenCalledWith('final', 10, expect.any(AbortSignal))
    expect(state.sections.value.find((s) => s.id === 'watchlist')?.items).toHaveLength(3)
    state.tab.value = 'watchlist'
    expect(state.sections.value[0]?.items).toHaveLength(10)
    expect(state.sections.value[0]?.items.slice(0, 2).map((item) => item.key)).toEqual(['watchlist:0', 'watchlist:1'])
    expect(state.tabs.value.find((t) => t.id === 'watchlist')?.count).toBe(10)
    const signal = mocks.catalog.mock.calls[0]?.[2]
    state.query.value = 'other'
    await nextTick()
    expect(signal?.aborted).toBe(true)
  })
  it('keys same-name authors by provider ID', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockResolvedValue({
      available: true,
      books: [],
      authors: [1, 2].map((id) => ({ name: 'Same', providerIds: { hardcover: String(id) } }) as MonitoredAuthorSearchResult),
    })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'same'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((s) => s.id === 'hardcoverAuthors')?.items.map((i) => i.key)).toEqual(['hardcoverAuthor:1', 'hardcoverAuthor:2'])
  })
  it.each(['permission', 'capability', 'failure'])('does not ask serial providers without %s', async (reason) => {
    if (reason !== 'permission') mocks.permissions.add(Permission.WebSerialAccess)
    if (reason === 'capability') mocks.capabilities.mockResolvedValue(capabilities(false))
    if (reason === 'failure') mocks.capabilities.mockRejectedValue(new Error('offline'))
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(mocks.suggest).not.toHaveBeenCalled()
    expect(mocks.discover).not.toHaveBeenCalled()
    expect(mocks.capabilities).toHaveBeenCalledTimes(reason === 'permission' ? 0 : 1)
  })

  it('loads local novels, filters ownership, caps All and opens every novel target', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({
      query: 'final',
      suggestions: [suggestion({ inLibrary: true }), ...[1, 2, 3, 4].map((id) => suggestion({ matchId: String(id) })), suggestion()],
    })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'fi'
    await vi.runAllTimersAsync()
    expect(mocks.suggest).toHaveBeenCalledWith('fi', expect.any(AbortSignal))
    expect(mocks.discover).not.toHaveBeenCalled()
    expect(state.sections.value.find((s) => s.id === 'lightNovels')?.items).toHaveLength(3)
    state.tab.value = 'lightNovels'
    const items = state.sections.value[0]!.items
    expect(items).toHaveLength(6)
    state.activate(items[1]!)
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { series: 'novel:1' } })
    state.activate(items[5]!)
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { q: 'Omniscient Reader', kind: 'novel' } })
  })

  it('runs both external members once from the Manga tab despite strong matches and shows all manga', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.discover.mockResolvedValue({
      results: [catalogEntry({ inLibrary: true }), ...[1, 2, 3, 4].map((id) => catalogEntry({ matchId: String(id) }))],
      fallback: null,
    })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')]
    await vi.runAllTimersAsync()
    expect(mocks.discover).not.toHaveBeenCalled()
    const manual = state.sections.value.flatMap((s) => s.items).find((i) => i.kind === 'externalSearch')
    expect(manual).toMatchObject({ label: 'commandPalette.external.searchProviders' })
    state.tab.value = 'manga'
    await vi.runAllTimersAsync()
    state.activate({ kind: 'externalSearch', key: 'externalSearch', label: 'Search', providers: ['hardcover'] })
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    expect(mocks.discover).toHaveBeenCalledWith('final', 'manga', expect.any(AbortSignal))
    expect(mocks.discover).toHaveBeenCalledTimes(2)
    expect(state.sections.value[0]!.items).toHaveLength(6)
    state.activate(state.sections.value[0]!.items[1]!)
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { series: 'manga:1' } })
    state.activate(state.sections.value[0]!.items[5]!)
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { q: 'final', kind: 'manga' } })
    state.tab.value = 'all'
    expect(state.sections.value.find((s) => s.id === 'manga')?.items).toHaveLength(3)
  })

  it.each([true, false])('uses the single-member manual title when Hardcover allowed is %s', async (hardcover) => {
    mocks.permissions.add(hardcover ? Permission.BookRequestAccess : Permission.WebSerialAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')]
    await vi.runAllTimersAsync()
    expect(state.sections.value.flatMap((s) => s.items).find((i) => i.kind === 'externalSearch')).toMatchObject({
      label: 'commandPalette.external.searchProviders',
    })
  })

  it('resolves external members independently and keeps Hardcover on manga failure', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.discover.mockRejectedValue(new Error('offline'))
    mocks.hardcover.mockResolvedValue({
      available: true,
      books: [{ slug: 'one', title: 'Final', authorNames: [], seriesName: null, coverUrl: null }],
      authors: [],
    })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((s) => s.id === 'hardcoverBooks')?.items[0]?.kind).toBe('hardcoverBook')
    expect(state.sections.value.some((s) => s.id === 'manga')).toBe(false)
  })

  it.each(['manual', 'hardcover'])('starts both external calls in parallel from %s and resolves each section independently', async (trigger) => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.permissions.add(Permission.BookRequestAccess)
    let finishManga!: (result: Awaited<ReturnType<typeof discoverSerials>>) => void
    let finishHardcover!: (result: HardcoverUniversalSearchResult) => void
    mocks.discover.mockReturnValue(
      new Promise((resolve) => {
        finishManga = resolve
      }),
    )
    mocks.hardcover.mockReturnValue(
      new Promise((resolve) => {
        finishHardcover = resolve
      }),
    )
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    mocks.books.value = [book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')]
    await vi.runAllTimersAsync()
    if (trigger === 'manual')
      state.activate({ kind: 'externalSearch', key: 'manual', label: 'Search', providers: ['hardcover', 'manga', 'lightNovels'] })
    else state.tab.value = 'hardcover'
    await nextTick()
    expect(mocks.discover).toHaveBeenCalledTimes(2)
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    state.tab.value = 'all'
    expect(state.sections.value.find((s) => s.id === 'manga')?.items.map((i) => i.kind)).toEqual(['skeleton', 'skeleton'])
    expect(state.sections.value.find((s) => s.id === 'hardcoverBooks')?.items.map((i) => i.kind)).toEqual(['skeleton', 'skeleton'])
    finishHardcover({ available: true, books: [{ slug: 'one', title: 'Final' } as HardcoverSearchBook], authors: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sections.value.find((s) => s.id === 'hardcoverBooks')?.items[0]?.kind).toBe('hardcoverBook')
    expect(state.sections.value.find((s) => s.id === 'manga')?.items[0]?.kind).toBe('skeleton')
    finishManga({ results: [catalogEntry()], fallback: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sections.value.find((s) => s.id === 'manga')?.items[0]?.kind).toBe('manga')
  })

  it('fetches capabilities once per open and aborts serial requests on query change and close', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    const novelSignal = mocks.suggest.mock.calls[0]![1] as AbortSignal
    const mangaSignal = mocks.discover.mock.calls[0]![2] as AbortSignal
    state.query.value = 'next'
    await vi.runAllTimersAsync()
    expect(novelSignal.aborted).toBe(true)
    expect(mangaSignal.aborted).toBe(true)
    expect(mocks.capabilities).toHaveBeenCalledTimes(1)
    const nextSignal = mocks.discover.mock.calls[1]![2] as AbortSignal
    state.isOpen.value = false
    await nextTick()
    expect(nextSignal.aborted).toBe(true)
    state.isOpen.value = true
    await nextTick()
    expect(mocks.capabilities).toHaveBeenCalledTimes(2)
  })

  it.each(['disabled', 'unavailable', 'empty'] as const)('silently ignores manga fallback %s and hides its empty tab', async (fallback) => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.discover.mockResolvedValue({ results: [catalogEntry()], fallback })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(state.sections.value.some((s) => s.id === 'manga')).toBe(false)
    expect(state.tabs.value.some((t) => t.id === 'manga')).toBe(false)
  })

  it('never treats light novels as strong local matches', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [1, 2, 3].map((id) => suggestion({ title: `Final ${id}` })) })
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(300)
    expect(state.sections.value.find((s) => s.id === 'manga')?.items.map((i) => i.kind)).toEqual(['skeleton', 'skeleton'])
    expect(mocks.discover).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(mocks.discover).toHaveBeenCalledTimes(2)
  })
  it('waits for capabilities when an external tab is selected immediately after opening', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.permissions.add(Permission.WebSerialAccess)
    let ready!: (value: Awaited<ReturnType<typeof fetchCapabilities>>) => void
    mocks.capabilities.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve
      }),
    )
    const state = setup()
    state.isOpen.value = true
    state.query.value = 'final'
    state.tab.value = 'hardcover'
    await nextTick()
    expect(mocks.hardcover).not.toHaveBeenCalled()
    ready(capabilities())
    await vi.runAllTimersAsync()
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    expect(mocks.discover).toHaveBeenCalledTimes(2)
  })
})

describe('round two regressions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.permissions.clear()
    mocks.books = ref([])
    mocks.bookTotal = ref(0)
    mocks.catalog.mockResolvedValue([])
    mocks.hardcover.mockResolvedValue({ available: true, books: [], authors: [] })
    mocks.capabilities.mockResolvedValue(capabilities())
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [] })
    mocks.discover.mockResolvedValue({ results: [], fallback: null })
    mocks.fetchAuthors.mockResolvedValue({ items: [], total: 0 })
    mocks.fetchSeries.mockResolvedValue({ items: [], total: 0 })
  })
  afterEach(() => vi.useRealTimers())

  it('loads capabilities and continue reading when mounted open', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    setup(true)
    await nextTick()
    expect(mocks.capabilities).toHaveBeenCalledOnce()
    expect(mocks.api).toHaveBeenCalledOnce()
  })

  it('does not search Watchlist for two characters', async () => {
    mocks.permissions.add(Permission.BookRequestAccess)
    const state = setup()
    state.query.value = 'ab'
    await vi.runAllTimersAsync()
    expect(mocks.catalog).not.toHaveBeenCalled()
  })

  it('keeps distinct keys for suggestions sharing a match ID', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({
      query: 'final',
      suggestions: [suggestion({ matchId: '1', entries: [] }), suggestion({ matchId: '1', entries: [] })],
    })
    const state = setup(true)
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    const keys = state.sections.value.find((s) => s.id === 'lightNovels')!.items.map((i) => i.key)
    expect(new Set(keys).size).toBe(2)
  })

  it('starts all three members in parallel with one signal and exposes the novel tab before answers', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockReturnValue(new Promise(() => {}))
    mocks.discover.mockReturnValue(new Promise(() => {}))
    const state = setup(true)
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(300)
    expect(state.tabs.value.some((t) => t.id === 'lightNovels')).toBe(true)
    expect(state.sections.value.find((s) => s.id === 'lightNovels')?.items.map((i) => i.kind)).toEqual(['skeleton', 'skeleton'])
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.hardcover).toHaveBeenCalledOnce()
    expect(mocks.discover.mock.calls.map((c) => c[1])).toEqual(['manga', 'novel'])
    expect(mocks.discover.mock.calls.every((c) => c[2] === mocks.hardcover.mock.calls[0]![1])).toBe(true)
  })

  it('merges index suggestions first, deduplicates MangaBaka and removes owned entries', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({
      query: 'final',
      suggestions: [suggestion({ matchId: '1' }), suggestion({ matchId: 'owned', inLibrary: true })],
    })
    mocks.discover.mockResolvedValue({
      results: [catalogEntry({ matchId: '1' }), catalogEntry({ matchId: '2' }), catalogEntry({ matchId: '3', inLibrary: true })],
      fallback: null,
    })
    const state = setup(true)
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((s) => s.id === 'lightNovels')?.items.map((i) => i.kind)).toEqual(['lightNovel', 'lightNovelEntry'])
    state.tab.value = 'lightNovels'
    await nextTick()
    expect(state.sections.value[0]?.items.at(-1)?.kind).toBe('seriesMore')
    state.activate({ kind: 'lightNovelEntry', key: 'entry', entry: catalogEntry({ matchId: '2' }) })
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { series: 'novel:2' } })
    state.activate({ kind: 'seriesMore', seriesKind: 'novel', key: 'more' })
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({ path: '/web-serials', query: { q: 'final', kind: 'novel' } })
  })

  it('preserves other members when manga fails', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.discover.mockImplementation(async (_q, kind) => {
      if (kind === 'manga') throw new Error('offline')
      return { results: [catalogEntry()], fallback: null }
    })
    const state = setup(true)
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((s) => s.id === 'lightNovels')?.items[0]?.kind).toBe('lightNovelEntry')
    expect(mocks.hardcover).toHaveBeenCalledOnce()
  })
})

it.each([
  { hardcover: true, serials: false, providers: ['hardcover'], label: 'commandPalette.tabs.hardcover' },
  { hardcover: false, serials: true, providers: ['manga', 'lightNovels'], label: 'commandPalette.external.webSerials' },
  { hardcover: true, serials: true, providers: ['hardcover', 'manga', 'lightNovels'], label: 'commandPalette.external.moreSources' },
])('labels manual sections by providers: $providers', async ({ hardcover, serials, providers, label }) => {
  vi.useFakeTimers()
  mocks.permissions.clear()
  if (hardcover) mocks.permissions.add(Permission.BookRequestAccess)
  if (serials) mocks.permissions.add(Permission.WebSerialAccess)
  mocks.books = ref([book(1, 'Final One'), book(2, 'Final Two'), book(3, 'Final Three')])
  mocks.bookTotal = ref(3)
  mocks.catalog.mockResolvedValue([])
  mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [] })
  mocks.fetchAuthors.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchSeries.mockResolvedValue({ items: [], total: 0 })
  mocks.capabilities.mockResolvedValue(capabilities())
  const state = setup(true)
  state.query.value = 'final'
  await vi.runAllTimersAsync()
  const section = state.sections.value.find((s) => s.id === 'external')
  expect(section?.label).toBe(label)
  expect(section?.items[0]).toMatchObject({ kind: 'externalSearch', providers })
  vi.useRealTimers()
})

it('returns to All after the novel tab finishes empty', async () => {
  vi.useFakeTimers()
  mocks.permissions.clear()
  mocks.permissions.add(Permission.WebSerialAccess)
  mocks.books = ref([])
  mocks.bookTotal = ref(0)
  mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [] })
  mocks.discover.mockResolvedValue({ results: [], fallback: null })
  mocks.fetchAuthors.mockResolvedValue({ items: [], total: 0 })
  mocks.fetchSeries.mockResolvedValue({ items: [], total: 0 })
  mocks.capabilities.mockResolvedValue(capabilities())
  const state = setup(true)
  state.query.value = 'final'
  await nextTick()
  state.tab.value = 'lightNovels'
  await vi.runAllTimersAsync()
  expect(state.tabs.value.some((t) => t.id === 'lightNovels')).toBe(false)
  expect(state.tab.value).toBe('all')
  vi.useRealTimers()
})

describe('round three regressions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.permissions.clear()
    requestVisibility.showBookRequests.value = true
    mocks.books = ref([])
    mocks.bookTotal = ref(0)
    mocks.catalog.mockResolvedValue([])
    mocks.hardcover.mockResolvedValue({ available: true, books: [], authors: [] })
    mocks.capabilities.mockResolvedValue(capabilities())
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [] })
    mocks.discover.mockResolvedValue({ results: [], fallback: null })
    mocks.fetchAuthors.mockResolvedValue({ items: [], total: 0 })
    mocks.fetchSeries.mockResolvedValue({ items: [], total: 0 })
  })
  afterEach(() => {
    requestVisibility.showBookRequests.value = true
    vi.useRealTimers()
  })
  it('falls back when Hardcover has only hidden books', async () => {
    requestVisibility.showBookRequests.value = false
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockResolvedValue({ available: true, books: [{ title: 'Final' } as HardcoverSearchBook], authors: [] })
    const state = setup(true)
    state.query.value = 'final'
    state.tab.value = 'hardcover'
    await vi.runAllTimersAsync()
    expect(state.tab.value).toBe('all')
  })
  it('does not show a books skeleton with Requests hidden', async () => {
    requestVisibility.showBookRequests.value = false
    mocks.permissions.add(Permission.BookRequestAccess)
    mocks.hardcover.mockReturnValue(new Promise(() => {}))
    const state = setup(true)
    state.query.value = 'final'
    await vi.advanceTimersByTimeAsync(300)
    expect(state.sections.value.some((section) => section.id === 'hardcoverBooks')).toBe(false)
  })
  it.each(['manga', 'lightNovels'] as const)('keeps owned entries on the %s tab only', async (tab) => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.discover.mockResolvedValue({ results: [catalogEntry({ inLibrary: true })], fallback: null })
    const state = setup(true)
    state.query.value = 'final'
    await vi.runAllTimersAsync()
    expect(state.sections.value.some((section) => section.id === tab)).toBe(false)
    expect(state.tabs.value.find((option) => option.id === tab)?.count).toBe(1)
    expect(state.tabs.value.find((option) => option.id === 'all')?.count).toBe(0)
    state.tab.value = tab
    await vi.runAllTimersAsync()
    expect(state.sections.value[0]?.items[0]).toMatchObject({ entry: { inLibrary: true } })
    expect(state.tabs.value.find((option) => option.id === tab)?.count).toBe(1)
    state.activate(state.sections.value[0]!.items[0]!)
    expect(state.handlers.navigate).toHaveBeenLastCalledWith({
      path: '/web-serials',
      query: { series: `${tab === 'manga' ? 'manga' : 'novel'}:1995` },
    })
  })
  it('keeps owned index suggestions on Light novels', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.suggest.mockResolvedValue({ query: 'final', suggestions: [suggestion({ inLibrary: true })] })
    const state = setup(true)
    state.query.value = 'fi'
    await vi.runAllTimersAsync()
    expect(state.sections.value.some((section) => section.id === 'lightNovels')).toBe(false)
    state.tab.value = 'lightNovels'
    await vi.runAllTimersAsync()
    expect(state.sections.value[0]?.items[0]).toMatchObject({ suggestion: { inLibrary: true } })
    expect(state.tabs.value.find((option) => option.id === 'lightNovels')?.count).toBe(1)
  })
  it('ranks alternative titles and carries the matching AKA', async () => {
    mocks.permissions.add(Permission.WebSerialAccess)
    mocks.discover.mockResolvedValue({
      results: [catalogEntry({ matchId: 'other' }), catalogEntry({ title: 'Bloom Into You', altTitles: ['Al final me convertiré en ti'] })],
      fallback: null,
    })
    const state = setup(true)
    state.query.value = 'final me'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((section) => section.id === 'manga')?.items[0]).toMatchObject({ aka: 'Al final me convertiré en ti' })
    state.query.value = 'Bloom'
    await vi.runAllTimersAsync()
    expect(state.sections.value.find((section) => section.id === 'manga')?.items[0]).not.toHaveProperty('aka')
  })
})
