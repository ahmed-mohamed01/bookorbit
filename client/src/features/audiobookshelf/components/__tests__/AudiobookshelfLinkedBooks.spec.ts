import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookStateBucket,
  AudiobookshelfBookStatePage,
  AudiobookshelfCleanupResult,
} from '@bookorbit/types'
import type { BookSearchOption } from '../../api/audiobookshelf.api'
import AudiobookshelfLinkedBooks from '../AudiobookshelfLinkedBooks.vue'

function emptyPage(): AudiobookshelfBookStatePage {
  return { items: [], total: 0, page: 0, pageSize: 20 }
}

function bookState(overrides: Partial<AudiobookshelfBookState> = {}): AudiobookshelfBookState {
  return {
    absLibraryItemId: 'li-1',
    absTitle: 'ABS Title',
    absAuthorName: 'ABS Author',
    absSeriesName: null,
    absLibraryName: null,
    absPath: null,
    bookId: null,
    bookTitle: null,
    bookAuthorName: null,
    bookSeriesName: null,
    bookLibraryName: null,
    bookFolderPath: null,
    matchMethod: null,
    matchConfidence: null,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: null,
    ...overrides,
  }
}

function setBucketItems(bucket: AudiobookshelfBookStateBucket, items: AudiobookshelfBookState[]): void {
  pages[bucket] = { items, total: items.length, page: 0, pageSize: 20 }
}

const pages = reactive<Record<AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage>>({
  linked: emptyPage(),
  'needs-review': emptyPage(),
  unmatched: emptyPage(),
})
const bucketLoading = reactive<Record<AudiobookshelfBookStateBucket, boolean>>({ linked: false, 'needs-review': false, unmatched: false })
const bucketErrors = reactive<Record<AudiobookshelfBookStateBucket, string | null>>({ linked: null, 'needs-review': null, unmatched: null })
const searchQuery = ref('')
const loading = ref(false)
const rescanning = ref(false)
const cleaningUp = ref(false)
const error = ref<string | null>(null)
const actionId = ref<string | null>(null)

const mocks = vi.hoisted(() => ({
  loadBucket: vi.fn<() => Promise<void>>(),
  loadAllBuckets: vi.fn<() => Promise<void>>(),
  setSearchQuery: vi.fn<() => Promise<void>>(),
  confirmMatch: vi.fn<() => Promise<boolean>>(),
  linkBook: vi.fn<() => Promise<boolean>>(),
  unlinkBook: vi.fn<() => Promise<boolean>>(),
  setExcluded: vi.fn<() => Promise<boolean>>(),
  rescan: vi.fn<() => Promise<boolean>>(),
  cleanupStale: vi.fn<() => Promise<AudiobookshelfCleanupResult | null>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useAudiobookshelfLinkedBooks', () => ({
  useAudiobookshelfLinkedBooks: () => ({
    pages,
    searchQuery,
    loading,
    bucketLoading,
    rescanning,
    cleaningUp,
    error,
    bucketErrors,
    actionId,
    ...mocks,
  }),
}))

vi.mock('../../api/audiobookshelf.api', () => ({
  searchAudiobookshelfLinkCandidates: vi.fn<(query: string, limit?: number) => Promise<BookSearchOption[]>>(() => Promise.resolve([])),
}))

vi.mock('vue-sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

type Wrapper = ReturnType<typeof mount>

function rescanButton(wrapper: Wrapper) {
  return wrapper.findAll('button').find((button) => button.text().includes('Rescan matches'))!
}

function tabButton(wrapper: Wrapper, label: string) {
  return wrapper.findAll('button').find((button) => button.text().includes(label))!
}

async function mountLinkedBooks() {
  const wrapper = mount(AudiobookshelfLinkedBooks)
  await flushPromises()
  return wrapper
}

describe('AudiobookshelfLinkedBooks header actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loading.value = false
    rescanning.value = false
    cleaningUp.value = false
    error.value = null
    mocks.loadAllBuckets.mockResolvedValue(undefined)
    mocks.rescan.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The cleanup affordance now lives next to the sync status line, driven by the stored stale count,
  // so this header offers a rescan only.
  it('no longer renders a cleanup action', async () => {
    const wrapper = await mountLinkedBooks()

    expect(wrapper.find('[data-testid="abs-cleanup-stale"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="abs-cleanup-summary"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Clean up stale')
    expect(mocks.cleanupStale).not.toHaveBeenCalled()
  })

  it('runs a rescan on click and reports it', async () => {
    const wrapper = await mountLinkedBooks()

    await rescanButton(wrapper).trigger('click')
    await flushPromises()

    expect(mocks.rescan).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Audiobookshelf match rescan completed')
  })

  it('surfaces the composable error when the rescan fails', async () => {
    mocks.rescan.mockResolvedValue(false)
    error.value = 'Audiobookshelf sync is not configured'
    const wrapper = await mountLinkedBooks()

    await rescanButton(wrapper).trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Audiobookshelf sync is not configured')
  })

  it('disables the rescan while a rescan or a cleanup is running', async () => {
    rescanning.value = true
    const wrapper = await mountLinkedBooks()
    expect(rescanButton(wrapper).attributes('disabled')).toBeDefined()

    rescanning.value = false
    cleaningUp.value = true
    await flushPromises()
    expect(rescanButton(wrapper).attributes('disabled')).toBeDefined()

    cleaningUp.value = false
    await flushPromises()
    expect(rescanButton(wrapper).attributes('disabled')).toBeUndefined()
  })
})

describe('AudiobookshelfLinkedBooks item details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loading.value = false
    rescanning.value = false
    cleaningUp.value = false
    error.value = null
    mocks.loadAllBuckets.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    pages.linked = emptyPage()
    pages['needs-review'] = emptyPage()
    pages.unmatched = emptyPage()
  })

  it('shows the Audiobookshelf library, series, and path alongside the linked BookOrbit book', async () => {
    setBucketItems('linked', [
      bookState({
        absLibraryName: 'Library A',
        absSeriesName: 'Series One',
        absPath: '/mnt/abs/library-a/series-one/book',
        bookId: 42,
        bookTitle: 'Book Title',
        bookAuthorName: 'Book Author',
        bookLibraryName: 'BookOrbit Library',
        bookSeriesName: 'BO Series',
        bookFolderPath: '/books/library/author/book',
      }),
    ])
    const wrapper = await mountLinkedBooks()

    expect(wrapper.get('[data-testid="abs-item-meta"]').text()).toBe('Library A · Series One')
    expect(wrapper.get('[data-testid="abs-item-path"]').text()).toBe('/mnt/abs/library-a/series-one/book')
    expect(wrapper.get('[data-testid="abs-book-meta"]').text()).toBe('BookOrbit Library · BO Series')
    expect(wrapper.get('[data-testid="abs-book-path"]').text()).toBe('/books/library/author/book')
  })

  it('omits the missing half of the meta line when only one of library or series is present', async () => {
    setBucketItems('linked', [bookState({ absLibraryName: 'Library A', absSeriesName: null, absPath: null })])
    const wrapper = await mountLinkedBooks()

    expect(wrapper.get('[data-testid="abs-item-meta"]').text()).toBe('Library A')
    expect(wrapper.find('[data-testid="abs-item-path"]').exists()).toBe(false)
  })

  it('renders no meta line when both the library and series are null', async () => {
    setBucketItems('linked', [bookState({ absLibraryName: null, absSeriesName: null, absPath: '/mnt/abs/only-path' })])
    const wrapper = await mountLinkedBooks()

    expect(wrapper.find('[data-testid="abs-item-meta"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="abs-item-path"]').text()).toBe('/mnt/abs/only-path')
  })

  it('does not render the BookOrbit meta or path lines for an unlinked item', async () => {
    setBucketItems('unmatched', [
      bookState({ absLibraryName: 'Library A', absSeriesName: 'Series One', absPath: '/mnt/abs/unmatched', bookId: null }),
    ])
    const wrapper = await mountLinkedBooks()
    await tabButton(wrapper, 'Unmatched').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="abs-book-meta"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="abs-book-path"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="abs-item-meta"]').text()).toBe('Library A · Series One')
    expect(wrapper.get('[data-testid="abs-item-path"]').text()).toBe('/mnt/abs/unmatched')
  })
})
