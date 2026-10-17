import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { i18n } from '@/i18n'
import { catalogEntry, suggestion } from '@/features/web-serials/__tests__/fixtures'
import type { PaletteItem } from '../composables/useCommandPaletteResults'
import CommandPalette from './CommandPalette.vue'
import PaletteCover from './PaletteCover.vue'

enableAutoUnmount(afterEach)
vi.mock('@/features/book-requests/composables/useBookRequestVisibility', () => ({
  useBookRequestVisibility: () => ({ showBookRequests: ref(true) }),
}))

const state = vi.hoisted(() => ({ activate: vi.fn<(item: PaletteItem) => void>(), items: [] as PaletteItem[] }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn<(to: unknown) => Promise<void>>() }) }))
vi.mock('../composables/useCommandPalette', () => ({ useCommandPalette: () => ({ isOpen: ref(true), closePalette: vi.fn<() => void>() }) }))
vi.mock('../composables/useCommandPaletteResults', () => ({
  useCommandPaletteResults: () => ({
    activate: state.activate,
    sections: computed(() => [{ id: 'serials', label: 'Light novels', items: state.items }]),
    tabs: ref([]),
    isSearching: ref(true),
    loading: ref(false),
    settled: ref(true),
    hasMoreBooks: ref(false),
    loadingMoreBooks: ref(false),
    loadMoreBooks: vi.fn<() => void>(),
    clear: vi.fn<() => void>(),
  }),
}))
vi.mock('../composables/usePaletteRowActions', () => ({
  usePaletteRowActions: () => ({ watchedFormats: () => [], requestFormat: () => undefined, isFollowed: () => false, isFollowing: () => false }),
}))
vi.mock('@/features/book/composables/useCoverVersions', () => ({ useCoverVersions: () => ({ coverUrl: vi.fn<(bookId: number) => string>() }) }))
vi.mock('@/features/library/components/BookUploadModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/features/monitored/components/MonitorAuthorModal.vue', () => ({ default: { template: '<div />' } }))

const slot = { template: '<div><slot /></div>' }
function render(items: PaletteItem[]) {
  state.items = items
  state.activate.mockClear()
  return mount(CommandPalette, {
    global: {
      plugins: [i18n],
      stubs: {
        DialogRoot: slot,
        DialogPortal: slot,
        DialogOverlay: true,
        DialogContent: slot,
        DialogTitle: slot,
        DialogDescription: slot,
        BookCoverArtwork: true,
      },
    },
  })
}

describe('palette serial rows', () => {
  it('renders covers, highlighted titles, plural sites and the muted MTL chip without inline actions', async () => {
    const novel = suggestion({ title: 'Final Novel', cover: '/novel-cover', sourcesCount: 2, mtlOnly: true })
    const manga = catalogEntry({ title: 'Final Manga', coverUrl: '/manga-cover', authors: ['A', 'B'], year: 2020 })
    const wrapper = render([
      { kind: 'lightNovel', key: 'novel', suggestion: novel },
      { kind: 'manga', key: 'manga', entry: manga },
    ])
    await wrapper.get('input').setValue('Final')
    const rows = wrapper.findAll('[role="option"]')
    expect(rows[0]!.text()).toBe('Final Novel2 sitesMTL')
    expect(rows[1]!.text()).toBe('Final MangaA, B · 2020')
    expect(rows[0]!.find('button').exists()).toBe(false)
    expect(rows[1]!.find('button').exists()).toBe(false)
    expect(rows[0]!.find('.font-semibold').text()).toBe('Final')
    expect(wrapper.findAllComponents(PaletteCover).map((cover) => cover.props('src'))).toEqual(['/novel-cover', '/manga-cover'])
    await rows[0]!.trigger('click')
    expect(state.activate).toHaveBeenCalledWith({ kind: 'lightNovel', key: 'novel', suggestion: novel })
    await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(state.activate).toHaveBeenLastCalledWith({ kind: 'manga', key: 'manga', entry: manga })
  })

  it('renders the more row and singular site count, hiding MTL for translated novels', async () => {
    const wrapper = render([
      { kind: 'lightNovel', key: 'novel', suggestion: suggestion({ sourcesCount: 1 }) },
      { kind: 'seriesMore', seriesKind: 'manga', key: 'more' },
    ])
    expect(wrapper.text()).toContain('1 site')
    expect(wrapper.text()).not.toContain('MTL')
    const rows = wrapper.findAll('[role="option"]')
    expect(rows[1]!.text()).toBe('More on Web Serials')
    await rows[1]!.trigger('click')
    expect(state.activate).toHaveBeenLastCalledWith({ kind: 'seriesMore', seriesKind: 'manga', key: 'more' })
  })
})

it('keeps skeletons out of options and keyboard activation', async () => {
  const wrapper = render([{ kind: 'skeleton', section: 'hardcoverBooks', key: 'skeleton' }])
  expect(wrapper.findAll('[role="option"]')).toHaveLength(0)
  expect(wrapper.text()).toContain('No results')
  await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
  await wrapper.get('input').trigger('keydown', { key: 'Enter' })
  expect(state.activate).not.toHaveBeenCalled()
})

it.each([
  { providers: ['hardcover'] as const, description: 'Find books and authors to follow or request', hardcover: true },
  { providers: ['manga', 'lightNovels'] as const, description: 'Find manga and light novels to download', hardcover: false },
  { providers: ['hardcover', 'manga', 'lightNovels'] as const, description: 'Find books, authors, manga and light novels', hardcover: true },
])('brands manual rows for $providers', ({ providers, description, hardcover }) => {
  const wrapper = render([{ kind: 'externalSearch', key: 'manual', label: 'Search', description, providers: [...providers] }])
  const row = wrapper.get('[role="option"]')
  expect(row.text()).toContain(description)
  expect(row.text().includes('Hardcover')).toBe(hardcover)
  expect(wrapper.text()).toContain('No results')
})

it('proxies catalog work, book and author images', async () => {
  const { workFixture } = await import('@/features/monitored/testing/work-fixture')
  const wrapper = render([
    {
      kind: 'watchlist',
      key: 'work',
      hit: {
        work: workFixture({ coverUrl: 'https://covers.example/work.jpg' }),
        authorName: 'A',
        monitorAuthorId: 'a',
        authorModes: { ebook: 'off', audiobook: 'off' },
      },
    },
    {
      kind: 'hardcoverBook',
      key: 'book',
      book: { slug: 'b', title: 'B', authorNames: [], coverUrl: 'https://covers.example/book.jpg', seriesName: null },
    },
    {
      kind: 'hardcoverAuthor',
      key: 'author',
      author: {
        name: 'A',
        imageUrl: 'https://covers.example/author.jpg',
        providerIds: {},
        localAuthorId: null,
        bookCount: null,
        genres: [],
        alreadyMonitoredId: null,
      },
    },
  ])
  expect(wrapper.findAllComponents(PaletteCover).map((c) => c.props('src'))).toEqual([
    '/api/v1/monitored/cover?url=https%3A%2F%2Fcovers.example%2Fwork.jpg',
    '/api/v1/monitored/cover?url=https%3A%2F%2Fcovers.example%2Fbook.jpg',
  ])
  expect(wrapper.get('img').attributes('src')).toBe('/api/v1/monitored/cover?url=https%3A%2F%2Fcovers.example%2Fauthor.jpg')
})
it('keeps input focus when pressing inline Follow and Request buttons', async () => {
  const wrapper = render([
    { kind: 'hardcoverBook', key: 'book', book: { title: 'Final', authorNames: ['Author'], slug: 'final', coverUrl: null, seriesName: null } },
  ])
  document.body.appendChild(wrapper.element)
  const input = wrapper.get('input').element as HTMLInputElement
  input.focus()
  const buttons = wrapper.get('[role="option"]').findAll('button')
  expect(buttons).toHaveLength(2)
  for (const button of buttons) {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
  }
})
it('shows an owned series chip for catalog entries and index suggestions', () => {
  const wrapper = render([
    { kind: 'manga', key: 'manga', entry: catalogEntry({ inLibrary: true }) },
    { kind: 'lightNovel', key: 'novel', suggestion: suggestion({ inLibrary: true }) },
  ])
  for (const row of wrapper.findAll('[role="option"]')) expect(row.text()).toContain('In library')
})
it('renders a highlighted AKA line only for alternative matches', async () => {
  const wrapper = render([
    { kind: 'manga', key: 'aka', entry: catalogEntry({ title: 'Bloom Into You' }), aka: 'Al final me convertiré en ti' },
    { kind: 'manga', key: 'main', entry: catalogEntry({ title: 'Final' }) },
  ])
  await wrapper.get('input').setValue('final')
  const rows = wrapper.findAll('[role="option"]')
  expect(rows[0]!.text()).toContain('Also known as Al final me convertiré en ti')
  expect(rows[0]!.find('.text-muted-foreground .font-semibold').text()).toBe('final')
  expect(rows[1]!.text()).not.toContain('Also known as')
})
