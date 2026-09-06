import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { EditionLinkCounterpartSummary } from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '../../../../composables/useEditionLink'
import LinkBookControl from '../LinkBookControl.vue'

const toastMocks = vi.hoisted(() => ({ success: vi.fn<(...args: unknown[]) => void>(), error: vi.fn<(...args: unknown[]) => void>() }))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(...args: unknown[]) => boolean>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission }),
}))

function createMockState() {
  return {
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    candidates: ref<EditionLinkCandidate[]>([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    searchError: ref<string | null>(null),
    loadForBook: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    searchCandidates: vi.fn<() => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
    linkBook: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    unlink: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resetSearch: vi.fn<() => void>(),
  }
}

let mockState = createMockState()

vi.mock('@/features/book/composables/useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useEditionLink')>()
  return { ...actual, useEditionLink: () => mockState }
})

function createAlignmentState() {
  return {
    status: ref<string>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    anchorCount: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildBlocked: ref<string | null>(null),
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

let mockAlignment = createAlignmentState()

vi.mock('@/features/book/composables/useReadingAlignment', () => ({
  useReadingAlignment: () => mockAlignment,
}))

const stubs = {
  Popover: { name: 'Popover', props: ['open'], emits: ['update:open'], template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>' },
  PopoverContent: { template: '<div><slot /></div>' },
}

function makeBook(overrides = {}) {
  return {
    id: 10,
    libraryId: 1,
    libraryName: 'My Library',
    status: 'ok',
    folderPath: '/books',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    title: 'Test Book',
    subtitle: null,
    description: null,
    isbn10: null,
    isbn13: null,
    publisher: null,
    publishedDate: null,
    publishedYear: null,
    language: null,
    pageCount: null,
    seriesName: null,
    seriesIndex: null,
    rating: null,
    personalNote: null,
    personalNoteUpdatedAt: null,
    communityRatings: [],
    coverSource: null,
    hardcoverEditionId: null,
    providerIds: {},
    authors: [],
    genres: [],
    tags: [],
    files: [
      {
        id: 1,
        format: 'epub',
        role: 'content',
        sizeBytes: 100,
        absolutePath: '/b.epub',
        createdAt: '2026-01-01',
        filename: 'b.epub',
        durationSeconds: null,
      },
    ],
    lastWrittenAt: null,
    metadataScore: null,
    readStatus: null,
    audioMetadata: null,
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    collections: [],
    ...overrides,
  }
}

function mountControl(overrides = {}) {
  return mount(LinkBookControl, { props: { book: makeBook(overrides) }, global: { stubs } })
}

async function openPopover(wrapper: ReturnType<typeof mountControl>) {
  await wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', true)
  await flushPromises()
}

describe('LinkBookControl', () => {
  beforeEach(() => {
    mockState = createMockState()
    mockAlignment = createAlignmentState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('does not render when the book has both formats or neither', () => {
    const both = mountControl({
      files: [
        {
          id: 1,
          format: 'epub',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.epub',
          createdAt: '2026-01-01',
          filename: 'a.epub',
          durationSeconds: null,
        },
        {
          id: 2,
          format: 'm4b',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.m4b',
          createdAt: '2026-01-01',
          filename: 'a.m4b',
          durationSeconds: null,
        },
      ],
    })
    expect(both.find('button').exists()).toBe(false)

    const none = mountControl({ files: [] })
    expect(none.find('button').exists()).toBe(false)
  })

  it('renders the trigger for a single-format book and loads on open', async () => {
    const wrapper = mountControl()
    expect(wrapper.find('button').attributes('aria-label')).toBe('Link book')

    await openPopover(wrapper)
    expect(mockState.loadForBook).toHaveBeenCalledWith()
  })

  it('loads the link state on mount (for an eligible book) so the trigger title is accurate before opening', () => {
    mountControl()
    expect(mockState.loadForBook).toHaveBeenCalledWith()
  })

  it('does not fetch on mount for a book that cannot be linked (both formats)', () => {
    mountControl({
      files: [
        {
          id: 1,
          format: 'epub',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.epub',
          createdAt: '2026-01-01',
          filename: 'a.epub',
          durationSeconds: null,
        },
        {
          id: 2,
          format: 'm4b',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.m4b',
          createdAt: '2026-01-01',
          filename: 'a.m4b',
          durationSeconds: null,
        },
      ],
    })
    expect(mockState.loadForBook).not.toHaveBeenCalled()
  })

  it('carries a modality-specific alignment hint on the trigger title, before any popover open', () => {
    const textOnly = mountControl()
    expect(textOnly.find('button').attributes('title')).toContain('Link an audiobook')

    const audioOnly = mountControl({
      files: [
        {
          id: 1,
          format: 'm4b',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.m4b',
          createdAt: '2026-01-01',
          filename: 'a.m4b',
          durationSeconds: null,
        },
      ],
    })
    expect(audioOnly.find('button').attributes('title')).toContain('Link an ebook')
  })

  it('switches the trigger title to a manage message once linked', () => {
    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    const wrapper = mountControl()
    expect(wrapper.find('button').attributes('title')).toContain('Manage the linked edition')
  })

  it('marks the counterpart title with a format icon: audiobook for a text-only book, ebook for an audio-only book', () => {
    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    mockState.linkedCounterpart.value = { id: 20, title: 'The Way of Kings', authorName: 'Brandon Sanderson' }

    const textOnly = mountControl()
    expect(textOnly.find('[data-testid="edition-link-counterpart-format"]').attributes('aria-label')).toBe('Audiobook')

    const audioOnly = mountControl({
      files: [
        {
          id: 1,
          format: 'm4b',
          role: 'content',
          sizeBytes: 1,
          absolutePath: '/a.m4b',
          createdAt: '2026-01-01',
          filename: 'a.m4b',
          durationSeconds: null,
        },
      ],
    })
    expect(audioOnly.find('[data-testid="edition-link-counterpart-format"]').attributes('aria-label')).toBe('Ebook')
  })

  it('tints the trigger icon with the primary token once a link exists, and leaves it neutral otherwise', () => {
    const unlinked = mountControl()
    expect(unlinked.find('button').find('svg').classes()).not.toContain('text-primary')

    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    const linked = mountControl()
    expect(linked.find('button').find('svg').classes()).toContain('text-primary')
  })

  it('shows the proposed match and links through on confirm, with search collapsed by default', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: 'Some Narrator', score: 82 }
    })

    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(wrapper.text()).toContain('Proposed Audiobook')
    expect(wrapper.text()).toContain('Some Narrator')
    expect(wrapper.find('[data-testid="edition-link-search"]').exists()).toBe(false)

    const linkButton = wrapper.find('[data-testid="edition-link-proposed"]').find('button')
    await linkButton.trigger('click')
    await flushPromises()

    expect(mockState.linkBook).toHaveBeenCalledWith(99)
    expect(toastMocks.success).toHaveBeenCalled()
  })

  it('expands the search section on toggle and links a selected candidate', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: null, score: 60 }
    })
    mockState.searchCandidates.mockImplementation(async () => {
      mockState.candidates.value = [{ bookId: 55, title: 'Manual Match', authorName: 'Author X', score: 70 }]
      return mockState.candidates.value
    })

    const wrapper = mountControl()
    await openPopover(wrapper)
    expect(wrapper.find('[data-testid="edition-link-search"]').exists()).toBe(false)

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('Search for a match'))!
    await toggle.trigger('click')
    await flushPromises()

    expect(mockState.searchCandidates).toHaveBeenCalledWith('')
    expect(wrapper.text()).toContain('Manual Match')

    const candidateButton = wrapper.findAll('button').find((b) => b.text().includes('Manual Match'))!
    await candidateButton.trigger('click')
    await flushPromises()

    expect(mockState.linkBook).toHaveBeenCalledWith(55)
  })

  it('shows the linked counterpart and unlinks through the unlink action', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      mockState.linkedCounterpart.value = { id: 20, title: 'Linked Audiobook', authorName: 'Narrator Name' }
    })

    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(wrapper.text()).toContain('Linked Audiobook')
    expect(wrapper.text()).toContain('Narrator Name')

    const unlinkButton = wrapper.find('[data-testid="edition-link-linked"]').find('button')
    await unlinkButton.trigger('click')
    await flushPromises()

    expect(mockState.unlink).toHaveBeenCalledWith()
    expect(toastMocks.success).toHaveBeenCalled()
  })

  it('shows a search error message instead of the empty-results state when the search fails', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.proposed.value = null
    })
    mockState.searchCandidates.mockImplementation(async () => {
      mockState.searchError.value = 'Failed to search for a matching book'
      return []
    })

    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(wrapper.find('[data-testid="edition-link-search-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="edition-link-search-error"]').text()).toContain("Couldn't search")
    expect(wrapper.text()).not.toContain('No matches found.')
  })

  it('kicks off the alignment build right after a successful link', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: 'Some Narrator', score: 82 }
    })

    const wrapper = mountControl()
    await openPopover(wrapper)

    const linkButton = wrapper.find('[data-testid="edition-link-proposed"]').find('button')
    await linkButton.trigger('click')
    await flushPromises()

    expect(mockState.linkBook).toHaveBeenCalledWith(99)
    expect(mockAlignment.build).toHaveBeenCalledWith(10)
  })

  it('tints the icon blue while the alignment is processing and green once aligned', () => {
    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }

    mockAlignment.status.value = 'building'
    const processing = mountControl()
    expect(processing.find('button').find('svg').classes()).toContain('text-sky-500')
    expect(processing.find('button').attributes('title')).toContain('aligning positions')

    mockAlignment = createAlignmentState()
    mockAlignment.status.value = 'ready'
    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    const aligned = mountControl()
    expect(aligned.find('button').find('svg').classes()).toContain('text-emerald-500')
    expect(aligned.find('button').attributes('title')).toContain('positions aligned')

    mockAlignment = createAlignmentState()
    mockAlignment.status.value = 'failed'
    mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    const failed = mountControl()
    expect(failed.find('button').find('svg').classes()).toContain('text-destructive')
    expect(failed.find('button').attributes('title')).toContain('alignment failed')
  })

  describe('without library_edit_metadata permission', () => {
    beforeEach(() => {
      permissionMocks.hasPermission.mockReturnValue(false)
    })

    it('shows the linked status but hides the unlink button', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
        mockState.linkedCounterpart.value = { id: 20, title: 'Linked Audiobook', authorName: 'Narrator Name' }
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="edition-link-linked"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Linked Audiobook')
      expect(wrapper.find('[data-testid="edition-link-linked"]').find('button').exists()).toBe(false)
    })

    it('shows the suggested match but hides the confirm-link button and search section', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: 'Some Narrator', score: 82 }
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="edition-link-proposed"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Proposed Audiobook')
      expect(wrapper.find('[data-testid="edition-link-proposed"]').find('button').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-link-search"]').exists()).toBe(false)
      expect(mockState.searchCandidates).not.toHaveBeenCalled()
    })

    it('does not auto-open search for an unlinked, unmatched book', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.link.value = null
        mockState.proposed.value = null
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="edition-link-no-match"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('Search for a match')
      expect(mockState.searchCandidates).not.toHaveBeenCalled()
    })
  })
})
