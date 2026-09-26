import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, defineComponent } from 'vue'
import type {
  EditionLinkCounterpartSummary,
  EditionLinkMembers,
  EditionLinkRole,
  Library,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '../../../../composables/useEditionLink'
import type { ReadAlongBuildOutcome } from '../../../../composables/useReadAlong'
import LinkBookControl from '../LinkBookControl.vue'

// The rebuild is the one action here that deletes a library book, so it asks first. The dialog is
// stubbed so a test can answer it without driving a portalled overlay.
const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialogStub',
  props: { open: { type: Boolean, default: false } },
  emits: ['confirm', 'cancel'],
  template: '<div />',
})

async function confirmRebuild(wrapper: { findComponent: (c: unknown) => { vm: { $emit: (e: string) => void } } }) {
  wrapper.findComponent(ConfirmDialogStub).vm.$emit('confirm')
  await flushPromises()
}

const toastMocks = vi.hoisted(() => ({
  success: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(...args: unknown[]) => boolean>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission }),
}))

const editionLinkRecord: EditionLink = {
  id: 1,
  textBookId: 10,
  audioBookId: 20,
  readAlongBookId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function makeMembers(overrides: Partial<EditionLinkMembers> = {}): EditionLinkMembers {
  return {
    text: {
      id: 10,
      title: 'Test Book',
      authorName: 'Frank Herbert',
      progress: { percentage: 40, updatedAt: '2026-09-01' },
      narrationPercentage: null,
    },
    audio: {
      id: 20,
      title: 'Linked Audiobook',
      authorName: 'Narrator Name',
      progress: { percentage: 12, updatedAt: '2026-09-02' },
      narrationPercentage: null,
    },
    readAlong: null,
    ...overrides,
  }
}

function createMockState() {
  return {
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    role: ref<EditionLinkRole | null>(null),
    members: ref<EditionLinkMembers | null>(null),
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

function createReadAlongState() {
  return {
    status: ref<ReadAlongStatus>('none'),
    blocked: ref<ReadAlongBlockReason | null>(null),
    phase: ref<ReadAlongPhase | null>(null),
    transport: ref<StorytellerEffectiveTransport | null>(null),
    remoteTask: ref<string | null>(null),
    remoteProgress: ref<number | null>(null),
    targetLibraryName: ref<string | null>(null),
    remoteCopyBytes: ref({ epub: null, audio: null, readAlong: null }),
    keepRemoteCopy: ref(true),
    remoteCopyReclaimable: ref(true),
    setKeepRemoteCopy: vi.fn<(value: boolean) => void>(),
    resetKeepRemoteCopy: vi.fn<() => void>(),
    outputBook: ref<ReadAlongOutputBook | null>(null),
    targetLibraryId: ref<number | null>(null),
    error: ref<string | null>(null),
    mutating: ref(false),
    existingMatches: ref<StorytellerExistingMatch[]>([]),
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<() => Promise<ReadAlongBuildOutcome>>().mockResolvedValue('started'),
    fetchExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
  }
}

let mockReadAlong = createReadAlongState()

// The state composable is the only faked half. useReadAlongRow, the shared row wiring both hosts
// call, is the real one here and derives everything it hands the row from this mock.
vi.mock('@/features/book/composables/useReadAlong', () => ({
  useReadAlong: () => mockReadAlong,
}))

const libraryList = ref<Library[]>([])
const fetchLibraries = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: libraryList, fetchLibraries }),
}))

function makeLibrary(id: number, name: string, overrides: Partial<Library> = {}): Library {
  return { id, name, type: 'books', allowedFormats: [], ...overrides } as Library
}

// What /api/v1/libraries actually returns for anyone who is not a superuser: findAllForUser has no
// allowedFormats column, so the field never reaches the client.
function makeLibraryWithoutAllowedFormats(id: number, name: string, overrides: Partial<Library> = {}): Library {
  const library = makeLibrary(id, name, overrides)
  delete (library as Partial<Library>).allowedFormats
  return library
}

const stubs = {
  Popover: { name: 'Popover', props: ['open'], emits: ['update:open'], template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>' },
  PopoverContent: { template: '<div><slot /></div>' },
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
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
    readAloudSync: {
      mode: 'auto' as const,
      state: 'unavailable' as const,
      unavailableReason: 'no_media_overlay_epub' as const,
      overlayFileId: null,
      audioDurationSeconds: null,
      overlayDurationSeconds: null,
      durationDifferenceSeconds: null,
      durationDifferenceRatio: null,
      koreaderDownloadAvailable: false,
    },
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    collections: [],
    ...overrides,
  }
}

function mountControl(overrides = {}) {
  return mount(LinkBookControl, { props: { book: makeBook(overrides) }, global: { stubs: { ...stubs, ConfirmDialog: ConfirmDialogStub } } })
}

async function openPopover(wrapper: ReturnType<typeof mountControl>) {
  await wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', true)
  await flushPromises()
}

function linkWithMembers(members: EditionLinkMembers = makeMembers()) {
  mockState.link.value = editionLinkRecord
  mockState.role.value = 'text'
  mockState.members.value = members
}

describe('LinkBookControl', () => {
  beforeEach(() => {
    mockState = createMockState()
    mockAlignment = createAlignmentState()
    mockReadAlong = createReadAlongState()
    libraryList.value = []
    fetchLibraries.mockClear()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.info.mockReset()
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
    mockState.link.value = editionLinkRecord
    const wrapper = mountControl()
    expect(wrapper.find('button').attributes('title')).toContain('Manage the linked edition')
  })

  it('marks the suggested counterpart title with a format icon: audiobook for a text-only book, ebook for an audio-only book', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: null, score: 82 }
    })

    const textOnly = mountControl()
    await openPopover(textOnly)
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
    await openPopover(audioOnly)
    expect(audioOnly.find('[data-testid="edition-link-counterpart-format"]').attributes('aria-label')).toBe('Ebook')
  })

  it('tints the trigger icon with the primary token once a link exists, and leaves it neutral otherwise', () => {
    const unlinked = mountControl()
    expect(unlinked.find('button').find('svg').classes()).not.toContain('text-primary')

    mockState.link.value = editionLinkRecord
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
    mockState.link.value = editionLinkRecord

    mockAlignment.status.value = 'building'
    const processing = mountControl()
    expect(processing.find('button').find('svg').classes()).toContain('text-sky-500')
    expect(processing.find('button').attributes('title')).toContain('aligning positions')

    mockAlignment = createAlignmentState()
    mockAlignment.status.value = 'ready'
    mockState.link.value = editionLinkRecord
    const aligned = mountControl()
    expect(aligned.find('button').find('svg').classes()).toContain('text-emerald-500')
    expect(aligned.find('button').attributes('title')).toContain('positions aligned')

    mockAlignment = createAlignmentState()
    mockAlignment.status.value = 'failed'
    mockState.link.value = editionLinkRecord
    const failed = mountControl()
    expect(failed.find('button').find('svg').classes()).toContain('text-destructive')
    expect(failed.find('button').attributes('title')).toContain('alignment failed')
  })

  it('counts a building read-along as busy and a failed one as a failure on the trigger', () => {
    mockState.link.value = editionLinkRecord
    mockAlignment.status.value = 'ready'
    mockReadAlong.status.value = 'building'
    const building = mountControl()
    expect(building.find('button').find('svg').classes()).toContain('text-sky-500')
    expect(building.find('button').attributes('title')).toContain('building the read-along')

    mockReadAlong = createReadAlongState()
    mockReadAlong.status.value = 'failed'
    mockAlignment = createAlignmentState()
    mockAlignment.status.value = 'ready'
    mockState.link.value = editionLinkRecord
    const failed = mountControl()
    expect(failed.find('button').find('svg').classes()).toContain('text-destructive')
    expect(failed.find('button').attributes('title')).toContain('read-along build failed')
  })

  describe('linked members', () => {
    it('shows all three rows with their reading progress and marks the book being viewed', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(
          makeMembers({
            readAlong: {
              id: 30,
              title: 'Dune (read-along)',
              authorName: 'Frank Herbert',
              progress: { percentage: 55, updatedAt: '2026-09-03' },
              narrationPercentage: 61,
            },
          }),
        )
        mockReadAlong.status.value = 'ready'
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      const textRow = wrapper.find('[data-testid="edition-link-member-text"]')
      expect(textRow.text()).toContain('Test Book')
      expect(textRow.text()).toContain('40% read')
      expect(textRow.find('[data-testid="edition-link-this-book"]').exists()).toBe(true)

      const audioRow = wrapper.find('[data-testid="edition-link-member-audio"]')
      expect(audioRow.text()).toContain('Linked Audiobook')
      expect(audioRow.text()).toContain('12% listened')
      expect(audioRow.find('[data-testid="edition-link-this-book"]').exists()).toBe(false)

      const readAlongRow = wrapper.find('[data-testid="read-along-row"]')
      expect(readAlongRow.text()).toContain('Dune (read-along)')
      expect(readAlongRow.text()).toContain('55% read')
      expect(readAlongRow.text()).toContain('61% listened')

      expect(wrapper.find('[data-testid="edition-link-alignment-status"]').exists()).toBe(true)
    })

    it('unlinks through the unlink action and notes that the read-along book stays', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(
          makeMembers({
            readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, progress: null, narrationPercentage: null },
          }),
        )
        mockReadAlong.status.value = 'ready'
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.text()).toContain('Unlinking keeps the read-along book in its library.')

      await wrapper.find('[data-testid="edition-link-unlink"]').trigger('click')
      await flushPromises()

      expect(mockState.unlink).toHaveBeenCalledWith()
      expect(toastMocks.success).toHaveBeenCalled()
    })

    it('generates, rebuilds and imports a read-along through the row', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()
      expect(mockReadAlong.build).toHaveBeenCalledWith(10, {})

      mockReadAlong.existingMatches.value = [{ uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94 }]
      await flushPromises()
      await wrapper.find('[data-testid="read-along-import"]').trigger('click')
      await flushPromises()
      expect(mockReadAlong.build).toHaveBeenCalledWith(10, { useExistingUuid: 'uuid-1' })

      mockState.members.value = makeMembers({
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, progress: null, narrationPercentage: null },
      })
      mockReadAlong.status.value = 'ready'
      await flushPromises()
      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      await confirmRebuild(wrapper)
      await flushPromises()
      expect(mockReadAlong.build).toHaveBeenCalledWith(10, { force: true })
    })

    it('hands the keep-copy choice to the composable so the build can override the instance setting', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.get('[data-testid="read-along-keep-copy"]').trigger('click')

      expect(mockReadAlong.setKeepRemoteCopy).toHaveBeenCalledWith(false)
    })

    it('shows a refused rebuild on the ready row instead of leaving the click silent', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(
          makeMembers({
            readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, progress: null, narrationPercentage: null },
          }),
        )
        mockReadAlong.status.value = 'ready'
      })

      // What the server answers a rebuild with when the user cannot replace the previous output.
      mockReadAlong.build.mockImplementation(async () => {
        mockReadAlong.blocked.value = 'previous_output_not_deletable'
        return 'blocked'
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      await confirmRebuild(wrapper)
      await flushPromises()

      expect(mockReadAlong.build).toHaveBeenCalledWith(10, { force: true })
      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('permission to delete books')
      expect(wrapper.find('[data-testid="read-along-rebuild"]').attributes('disabled')).toBeDefined()
      expect(toastMocks.error).not.toHaveBeenCalled()
    })

    it('shows how the files reach Storyteller while the build runs', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
        mockReadAlong.status.value = 'building'
        mockReadAlong.phase.value = 'process'
        mockReadAlong.transport.value = 'shared-paths'
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-destination"]').attributes('aria-label')).toContain('reading the files where they are')
    })

    it('says the read-along exists rather than offering to build it again when its book is masked', async () => {
      // The server keeps a ready build whose output the caller cannot open, and sends no output book
      // with it. Pressing Generate there is rejected with a Forbidden the user cannot act on.
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(makeMembers({ readAlong: null }))
        mockReadAlong.status.value = 'ready'
        mockReadAlong.outputBook.value = null
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
    })

    it('keeps the ready row while the finished build waits for the link to list its book', async () => {
      // The status read lands before the reloaded members do, so the row has an output book but no
      // member yet. That window must not read as "no read-along", nor as one out of reach.
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(makeMembers({ readAlong: null }))
        mockReadAlong.status.value = 'ready'
        mockReadAlong.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-ready-pending"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })

    it('narrates a build that was accepted without starting anything', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })
      // An unforced build of a pair that already has a read-along answers 'ready' and starts no job.
      mockReadAlong.build.mockResolvedValue('ready')

      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()

      expect(toastMocks.info).toHaveBeenCalledWith('This pair already has a read-along, so nothing was rebuilt.')
      expect(toastMocks.error).not.toHaveBeenCalled()
    })

    it('reports a build request that the server refused', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })
      mockReadAlong.build.mockResolvedValue('failed')

      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()

      expect(toastMocks.error).toHaveBeenCalledWith('Failed to start the read-along build.')
    })

    it('looks up existing Storyteller matches when a linked pair has no read-along yet', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(mockReadAlong.fetchStatus).toHaveBeenCalledWith(10)
      expect(mockReadAlong.fetchExisting).toHaveBeenCalledWith(10)
    })

    it('does not look up existing matches once the read-along member exists', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers(
          makeMembers({
            readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, progress: null, narrationPercentage: null },
          }),
        )
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(mockReadAlong.fetchExisting).not.toHaveBeenCalled()
    })
  })

  describe('on the read-along book page', () => {
    it('shows a read-only membership view with no link, unlink or search actions', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.link.value = { ...editionLinkRecord, readAlongBookId: 30 }
        mockState.role.value = 'readAlong'
        mockState.members.value = makeMembers({
          readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, progress: null, narrationPercentage: null },
        })
      })

      const wrapper = mountControl({ id: 30 })
      await openPopover(wrapper)

      expect(wrapper.text()).toContain('Generated read-along of')
      expect(wrapper.find('[data-testid="edition-link-member-text"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="edition-link-member-audio"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-row"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-link-unlink"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-link-search"]').exists()).toBe(false)
    })
  })

  describe('generate-on-link tick box', () => {
    beforeEach(() => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: null, score: 82 }
      })
      mockReadAlong.targetLibraryId.value = 4
      libraryList.value = [makeLibrary(4, 'Read-alongs'), makeLibrary(5, 'Audiobooks')]
    })

    // The server can only answer for the configured library. Once the user picks another, that
    // answer is about a destination this build will not use, so the choice comes back.
    it('offers the keep-copy choice again when the destination is overridden', async () => {
      mockReadAlong.remoteCopyReclaimable.value = false
      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.get('[data-testid="read-along-on-link-checkbox"]').trigger('click')
      expect(wrapper.find('[data-testid="read-along-on-link-keep-copy"]').exists()).toBe(false)

      await wrapper.get('#read-along-target-library').setValue('5')

      expect(wrapper.find('[data-testid="read-along-on-link-keep-copy-moot"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-on-link-keep-copy"]').exists()).toBe(true)
    })

    it('says why there is no keep-copy choice when Storyteller holds no copy of its own', async () => {
      mockReadAlong.remoteCopyReclaimable.value = false
      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.get('[data-testid="read-along-on-link-checkbox"]').trigger('click')

      expect(wrapper.find('[data-testid="read-along-on-link-keep-copy"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-on-link-keep-copy-moot"]').text()).toContain('keeps no copy to remove')
    })

    // The tick box creates the first read-along for most pairs, so the per-book choice has to be on
    // this path too: without it that build can only take the instance default, which is delete.
    it('offers the per-book keep-copy choice beside the tick box', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.get('[data-testid="read-along-on-link-checkbox"]').trigger('click')

      // The shared mock starts from an instance default of "keep", so the change under test is the
      // user turning it off on this one book.
      const keep = wrapper.get('[data-testid="read-along-on-link-keep-copy"]')
      expect(keep.attributes('aria-checked')).toBe('true')

      await keep.trigger('click')
      expect(mockReadAlong.setKeepRemoteCopy).toHaveBeenCalledWith(false)

      expect(wrapper.get('[data-testid="read-along-on-link-keep-copy-hint"]').attributes('aria-label')).toContain('never deleted')
    })

    it('stays unticked by default and builds only the alignment on link', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)

      const checkbox = wrapper.find('[data-testid="read-along-on-link-checkbox"]')
      expect(checkbox.attributes('aria-checked')).toBe('false')
      expect(wrapper.find('[data-testid="read-along-on-link-options"]').exists()).toBe(false)

      await wrapper.find('[data-testid="edition-link-proposed"]').find('button').trigger('click')
      await flushPromises()

      expect(mockAlignment.build).toHaveBeenCalledWith(10)
      expect(mockReadAlong.build).not.toHaveBeenCalled()
    })

    // The select shows the configured library so the destination is visible, but an untouched select
    // is not a choice. The server reads any present targetLibraryId as "the caller picked a
    // destination" and discards the configured target folder, so the build would land in the
    // library's lowest-id folder instead of the one the admin configured - the same place the
    // Generate button on the row (which sends {}) would never send it.
    it('names no library when the select was never touched, so the configured folder survives', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)
      expect(fetchLibraries).toHaveBeenCalled()

      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')
      expect(wrapper.find('[data-testid="read-along-on-link-options"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-on-link-options"]').text()).toContain('Read-alongs')

      await wrapper.find('[data-testid="edition-link-proposed"]').find('button').trigger('click')
      await flushPromises()

      expect(mockState.linkBook).toHaveBeenCalledWith(99)
      expect(mockAlignment.build).toHaveBeenCalledWith(10)
      expect(mockReadAlong.build).toHaveBeenCalledWith(10, {})
    })

    it('still names the configured library when the user picks it deliberately', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')
      await wrapper.find('select').setValue('5')
      await wrapper.find('select').setValue('4')

      await wrapper.find('[data-testid="edition-link-proposed"]').find('button').trigger('click')
      await flushPromises()

      expect(mockReadAlong.build).toHaveBeenCalledWith(10, { targetLibraryId: 4 })
    })

    it('sends the library the user picked instead of the default', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)

      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')
      await wrapper.find('select').setValue('5')

      await wrapper.find('[data-testid="edition-link-proposed"]').find('button').trigger('click')
      await flushPromises()

      expect(mockReadAlong.build).toHaveBeenCalledWith(10, { targetLibraryId: 5 })
    })

    it('starts unticked on the next book, so an expensive build is never carried over', async () => {
      const first = mountControl()
      await openPopover(first)
      await first.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')
      expect(first.find('[data-testid="read-along-on-link-checkbox"]').attributes('aria-checked')).toBe('true')

      const next = mountControl({ id: 11 })
      await openPopover(next)

      expect(next.find('[data-testid="read-along-on-link-checkbox"]').attributes('aria-checked')).toBe('false')
    })

    it('only offers destinations the build endpoint would accept', async () => {
      libraryList.value = [
        makeLibrary(4, 'Read-alongs', { allowedFormats: ['epub'] }),
        makeLibrary(5, 'Audiobooks', { allowedFormats: ['m4b'] }),
        makeLibrary(6, 'Podcasts', { type: 'podcasts' }),
        makeLibrary(7, 'Anything'),
      ]

      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')

      const options = wrapper.findAll('select option').map((option) => option.text())
      expect(options).toContain('Read-alongs')
      expect(options).toContain('Anything')
      expect(options).not.toContain('Audiobooks')
      expect(options).not.toContain('Podcasts')
    })

    it('offers a library the API described without a format list, instead of blanking the popover', async () => {
      libraryList.value = [makeLibraryWithoutAllowedFormats(8, 'Everything'), makeLibrary(4, 'Read-alongs', { allowedFormats: ['epub'] })]

      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')

      const options = wrapper.findAll('select option').map((option) => option.text())
      expect(options).toContain('Everything')
      expect(options).toContain('Read-alongs')
    })

    it('stays tickable for the no_pair state an unlinked book actually reports', async () => {
      // An unlinked book has no pair, which is exactly what ticking the box is about to create, so
      // this is the one block reason that must not disable it.
      mockReadAlong.blocked.value = 'no_pair'

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-on-link-checkbox"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('[data-testid="read-along-on-link-hint"]').text()).toContain('Storyteller aligns the pair')
    })

    it.each([
      ['not_configured', "isn't configured"],
      ['unreachable', "can't be reached"],
      ['no_target_library', 'Pick a read-along library'],
      ['target_not_allowed', "don't have access"],
      ['format_not_allowed', "doesn't allow EPUB"],
    ] as const)('disables the box with the reason when Storyteller reports %s', async (blocked, expected) => {
      mockReadAlong.blocked.value = blocked

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-on-link-checkbox"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-testid="read-along-on-link-hint"]').text()).toContain(expected)
    })

    it('never builds a read-along on link once the box has been disabled behind the tick', async () => {
      const wrapper = mountControl()
      await openPopover(wrapper)
      await wrapper.find('[data-testid="read-along-on-link-checkbox"]').trigger('click')

      mockReadAlong.blocked.value = 'not_configured'
      await flushPromises()

      await wrapper.find('[data-testid="edition-link-proposed"]').find('button').trigger('click')
      await flushPromises()

      expect(mockState.linkBook).toHaveBeenCalledWith(99)
      expect(mockReadAlong.build).not.toHaveBeenCalled()
    })

    it('keeps the box tickable while Storyteller is merely busy', async () => {
      mockReadAlong.blocked.value = 'busy'

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-on-link-checkbox"]').attributes('disabled')).toBeUndefined()
    })

    it('replaces the tick box with guidance until there is something to link with', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.proposed.value = null
        mockState.candidates.value = []
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      // Generating a read-along needs a pair, so the option cannot be taken yet.
      expect(wrapper.find('[data-testid="read-along-on-link"]').exists()).toBe(false)
      const hint = wrapper.find('[data-testid="read-along-needs-counterpart"]')
      expect(hint.exists()).toBe(true)
      expect(hint.text()).toContain('audiobook')
    })

    it('offers the tick box once a match is proposed', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        mockState.proposed.value = { bookId: 99, title: 'Proposed Audiobook', authorName: 'Some Narrator', score: 82 }
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-on-link"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-needs-counterpart"]').exists()).toBe(false)
    })

    it('hides the tick box entirely without the upload permission', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="read-along-on-link"]').exists()).toBe(false)
      expect(mockReadAlong.fetchStatus).not.toHaveBeenCalled()
    })
  })

  describe('without library_edit_metadata permission', () => {
    beforeEach(() => {
      permissionMocks.hasPermission.mockReturnValue(false)
    })

    it('shows the linked members but hides the unlink button', async () => {
      mockState.loadForBook.mockImplementation(async () => {
        linkWithMembers()
      })

      const wrapper = mountControl()
      await openPopover(wrapper)

      expect(wrapper.find('[data-testid="edition-link-linked"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Linked Audiobook')
      expect(wrapper.find('[data-testid="edition-link-unlink"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-none"]').text()).toContain('No read-along yet')
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
      expect(wrapper.find('[data-testid="read-along-on-link"]').exists()).toBe(false)
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
