import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import AudiobookshelfLinkedBooks from '../AudiobookshelfLinkedBooks.vue'
import type { AudiobookshelfBookState, AudiobookshelfBookStatePage, AudiobookshelfMatchBucket, BookSearchOption } from '../../api/audiobookshelf.api'

const pages = reactive<Record<AudiobookshelfMatchBucket, AudiobookshelfBookStatePage>>({
  linked: { items: [], total: 0, page: 1, pageSize: 20 },
  'needs-review': { items: [], total: 0, page: 1, pageSize: 20 },
  unmatched: { items: [], total: 0, page: 1, pageSize: 20 },
})
const loading = ref(false)
const rescanning = ref(false)
const error = ref<string | null>(null)
const actionId = ref<string | null>(null)

const mocks = vi.hoisted(() => ({
  loadBucket: vi.fn<() => Promise<void>>(),
  loadAllBuckets: vi.fn<() => Promise<void>>(),
  confirmMatch: vi.fn<() => Promise<boolean>>(),
  linkBook: vi.fn<() => Promise<boolean>>(),
  unlinkBook: vi.fn<() => Promise<boolean>>(),
  setExcluded: vi.fn<() => Promise<boolean>>(),
  rescan: vi.fn<() => Promise<boolean>>(),
  searchCandidates: vi.fn<(query: string) => Promise<BookSearchOption[]>>(),
}))

vi.mock('../../composables/useAudiobookshelfLinkedBooks', () => ({
  useAudiobookshelfLinkedBooks: () => ({ pages, loading, rescanning, error, actionId, ...mocks }),
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

function setPage(bucket: AudiobookshelfMatchBucket, items: AudiobookshelfBookState[]): void {
  pages[bucket] = { items, total: items.length, page: 1, pageSize: 20 }
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
    rescanning.value = false
    error.value = null
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
})
