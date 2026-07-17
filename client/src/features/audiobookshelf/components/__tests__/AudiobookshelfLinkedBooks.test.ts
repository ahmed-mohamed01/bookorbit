import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import AudiobookshelfLinkedBooks from '../AudiobookshelfLinkedBooks.vue'
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookStateBucket,
  AudiobookshelfBookStatePage,
  BookSearchOption,
} from '../../api/audiobookshelf.api'

const pages = reactive<Record<AudiobookshelfBookStateBucket, AudiobookshelfBookStatePage>>({
  linked: { items: [], total: 0, page: 0, pageSize: 20 },
  'needs-review': { items: [], total: 0, page: 0, pageSize: 20 },
  unmatched: { items: [], total: 0, page: 0, pageSize: 20 },
})
const loading = ref(false)
const rescanning = ref(false)
const error = ref<string | null>(null)
const bucketLoading = reactive<Record<AudiobookshelfBookStateBucket, boolean>>({
  linked: false,
  'needs-review': false,
  unmatched: false,
})
const bucketErrors = reactive<Record<AudiobookshelfBookStateBucket, string | null>>({
  linked: null,
  'needs-review': null,
  unmatched: null,
})
const actionId = ref<string | null>(null)

const mocks = vi.hoisted(() => ({
  loadBucket: vi.fn<(bucket: AudiobookshelfBookStateBucket, page?: number) => Promise<void>>(),
  loadAllBuckets: vi.fn<() => Promise<void>>(),
  confirmMatch: vi.fn<() => Promise<boolean>>(),
  linkBook: vi.fn<() => Promise<boolean>>(),
  unlinkBook: vi.fn<() => Promise<boolean>>(),
  setExcluded: vi.fn<() => Promise<boolean>>(),
  rescan: vi.fn<() => Promise<boolean>>(),
  searchCandidates: vi.fn<(query: string) => Promise<BookSearchOption[]>>(),
}))

vi.mock('../../composables/useAudiobookshelfLinkedBooks', () => ({
  useAudiobookshelfLinkedBooks: () => ({ pages, loading, bucketLoading, rescanning, error, bucketErrors, actionId, ...mocks }),
}))

vi.mock('../../api/audiobookshelf.api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api/audiobookshelf.api')>()
  return { ...original, searchAudiobookshelfLinkCandidates: mocks.searchCandidates }
})

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))

function state(overrides: Partial<AudiobookshelfBookState>): AudiobookshelfBookState {
  return {
    absLibraryItemId: 'abs-1',
    absTitle: 'The Hobbit',
    absAuthorName: 'J.R.R. Tolkien',
    absCoverUrl: null,
    bookId: 42,
    bookTitle: 'The Hobbit',
    bookAuthorName: 'J.R.R. Tolkien',
    matchMethod: 'isbn',
    matchConfidence: 1,
    needsReview: false,
    matchError: null,
    syncExcluded: false,
    syncError: null,
    lastSyncedAt: null,
    ...overrides,
  }
}

function setPage(bucket: AudiobookshelfBookStateBucket, items: AudiobookshelfBookState[]): void {
  pages[bucket] = { items, total: items.length, page: 0, pageSize: 20 }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

async function clickButton(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().includes(label))
  expect(button, `button containing ${label}`).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

describe('AudiobookshelfLinkedBooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setPage('linked', [state({})])
    setPage('needs-review', [state({ absLibraryItemId: 'abs-review', absTitle: 'Dune', bookId: 7, bookTitle: 'Dune', needsReview: true })])
    setPage('unmatched', [state({ absLibraryItemId: 'abs-unmatched', absTitle: 'Hyperion', bookId: null, bookTitle: null, matchMethod: null })])
    loading.value = false
    bucketLoading.linked = false
    bucketLoading['needs-review'] = false
    bucketLoading.unmatched = false
    rescanning.value = false
    error.value = null
    bucketErrors.linked = null
    bucketErrors['needs-review'] = null
    bucketErrors.unmatched = null
    actionId.value = null
    mocks.loadAllBuckets.mockResolvedValue()
    mocks.loadBucket.mockResolvedValue()
    mocks.confirmMatch.mockResolvedValue(true)
    mocks.linkBook.mockResolvedValue(true)
    mocks.unlinkBook.mockResolvedValue(true)
    mocks.setExcluded.mockResolvedValue(true)
    mocks.rescan.mockResolvedValue(true)
    mocks.searchCandidates.mockResolvedValue([
      { id: 99, title: 'Hyperion', authors: ['Dan Simmons'], seriesName: 'Hyperion Cantos', libraryName: 'Audiobooks', formats: ['m4b'] },
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders all bucket counts and their bounded contents', async () => {
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    expect(wrapper.text()).toContain('The Hobbit')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="abs-cover-placeholder"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Linked 1')
    expect(wrapper.text()).toContain('Needs review 1')
    expect(wrapper.text()).toContain('Unmatched 1')

    await clickButton(wrapper, 'Needs review')
    expect(wrapper.text()).toContain('Dune')

    await clickButton(wrapper, 'Unmatched')
    expect(wrapper.text()).toContain('Hyperion')
  })

  it('confirms a needs-review match', async () => {
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Needs review')
    await clickButton(wrapper, 'Confirm match')

    expect(mocks.confirmMatch).toHaveBeenCalledWith('abs-review')
  })

  it('manually links an unmatched book through the bounded book picker', async () => {
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Unmatched')
    await clickButton(wrapper, 'Link manually')
    await wrapper.get('input[type="search"]').setValue('Hyperion')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    await clickButton(wrapper, 'Hyperion')
    await clickButton(wrapper, 'Link selected book')

    expect(mocks.searchCandidates).toHaveBeenCalledWith('Hyperion')
    expect(mocks.linkBook).toHaveBeenCalledWith('abs-unmatched', 99)
  })

  it('unlinks a linked book', async () => {
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Unlink')

    expect(mocks.unlinkBook).toHaveBeenCalledWith('abs-1')
  })

  it('loads the next zero-based page', async () => {
    pages.linked = { items: [state({})], total: 41, page: 0, pageSize: 20 }
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await wrapper.get('button[aria-label="Next page"]').trigger('click')
    await flushPromises()

    expect(mocks.loadBucket).toHaveBeenCalledWith('linked', 1)
    expect(wrapper.text()).toContain('Page 1 of 3')
  })

  it('retries the active bucket when that bucket has a load error', async () => {
    bucketErrors.unmatched = 'Unmatched bucket failed'
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Unmatched')
    expect(wrapper.text()).toContain('Unmatched bucket failed')
    await clickButton(wrapper, 'Retry')

    expect(mocks.loadBucket).toHaveBeenCalledWith('unmatched')
  })

  it('shows a switched failed bucket error while an unrelated bucket remains pending', async () => {
    loading.value = true
    bucketLoading.unmatched = true
    bucketErrors['needs-review'] = 'Needs review bucket failed'
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Needs review')

    expect(wrapper.text()).toContain('Needs review bucket failed')
    expect(wrapper.text()).toContain('Retry')
    expect(wrapper.text()).not.toContain('Loading needs-review books')

    await clickButton(wrapper, 'Retry')

    expect(mocks.loadBucket).toHaveBeenCalledWith('needs-review')
  })

  it('shows switched loaded bucket rows while an unrelated bucket remains pending', async () => {
    loading.value = true
    bucketLoading.unmatched = true
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Needs review')

    expect(wrapper.text()).toContain('Dune')
    expect(wrapper.text()).not.toContain('Loading needs-review books')
    expect(wrapper.text()).not.toContain('No books in this bucket.')
  })

  it('shows same-bucket retry loading and then success', async () => {
    const retry = deferred<void>()
    bucketErrors.unmatched = 'Unmatched bucket failed'
    setPage('unmatched', [])
    mocks.loadBucket.mockImplementationOnce(async (bucket: AudiobookshelfBookStateBucket) => {
      bucketErrors[bucket] = null
      bucketLoading[bucket] = true
      loading.value = true
      await retry.promise
      setPage(bucket, [
        state({
          absLibraryItemId: 'abs-unmatched-retry',
          absTitle: 'Retry success',
          bookId: null,
          bookTitle: null,
          matchMethod: null,
        }),
      ])
      bucketLoading[bucket] = false
      loading.value = false
    })
    const wrapper = mount(AudiobookshelfLinkedBooks)
    await flushPromises()

    await clickButton(wrapper, 'Unmatched')
    const retryButton = wrapper.findAll('button').find((candidate) => candidate.text().includes('Retry'))
    expect(retryButton, 'Retry button').toBeDefined()
    void retryButton!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Loading unmatched books')
    expect(wrapper.text()).not.toContain('Unmatched bucket failed')

    retry.resolve()
    await flushPromises()

    expect(wrapper.text()).toContain('Retry success')
    expect(wrapper.text()).not.toContain('Loading unmatched books')
  })
})
