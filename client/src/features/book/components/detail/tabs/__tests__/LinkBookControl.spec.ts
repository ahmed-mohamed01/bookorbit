import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
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
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '../../../../composables/useReadAlong'
import LinkBookControl from '../LinkBookControl.vue'

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
      coverVersion: null,
      progress: { percentage: 40, updatedAt: '2026-09-01' },
      narrationPercentage: null,
    },
    audio: {
      id: 20,
      title: 'Linked Audiobook',
      authorName: 'Narrator Name',
      coverVersion: null,
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
    cancel: vi.fn<(id: number) => Promise<ReadAlongCancelOutcome>>().mockResolvedValue('cancelled'),
    fetchExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
    reset: vi.fn<() => void>(),
  }
}

let mockReadAlong = createReadAlongState()

// The state composable is the only faked half. useReadAlongSection, the shared section wiring both
// hosts call, is the real one here and derives everything it hands the section from this mock.
vi.mock('@/features/book/composables/useReadAlong', () => ({
  useReadAlong: () => mockReadAlong,
}))

const libraryList = ref<Library[]>([])
const fetchLibraries = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: libraryList, fetchLibraries }),
}))

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
    coverMedia: [],
    covers: { ebook: null, audio: null },
    coverVersion: 'legacy:2024-01-01T00:00:00.000Z',
    collections: [],
    ...overrides,
  }
}

function mountControl(overrides = {}) {
  return mount(LinkBookControl, { props: { book: makeBook(overrides) }, global: { stubs: { ...stubs, ConfirmDialog: { template: '<div />' } } } })
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

const audioFile = {
  id: 1,
  format: 'm4b',
  role: 'content',
  sizeBytes: 1,
  absolutePath: '/a.m4b',
  createdAt: '2026-01-01',
  filename: 'a.m4b',
  durationSeconds: null,
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
    const both = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })
    expect(both.find('button').exists()).toBe(false)
    expect(mockState.loadForBook).not.toHaveBeenCalled()

    const none = mountControl({ files: [] })
    expect(none.find('button').exists()).toBe(false)
  })

  it('loads the link and its build statuses on mount, so the trigger is accurate before opening', async () => {
    mockState.loadForBook.mockImplementation(async () => {
      mockState.link.value = editionLinkRecord
    })
    const wrapper = mountControl()
    await flushPromises()

    expect(wrapper.find('button').attributes('aria-label')).toBe('Link book')
    expect(mockState.loadForBook).toHaveBeenCalledWith()
    expect(mockAlignment.fetchStatus).toHaveBeenCalledWith(10)
    expect(mockReadAlong.fetchStatus).toHaveBeenCalledWith(10)
  })

  it('names position sync in a modality-specific trigger title before a link exists', () => {
    expect(mountControl().find('button').attributes('title')).toBe('Link an audiobook to enable position sync.')
    expect(
      mountControl({ files: [audioFile] })
        .find('button')
        .attributes('title'),
    ).toBe('Link an ebook to enable position sync.')
  })

  it.each([
    ['none', 'none', 'text-primary', 'Manage the linked edition.'],
    ['building', 'none', 'text-info', 'Linked - building position sync...'],
    ['ready', 'none', 'text-success', 'Linked - position sync ready.'],
    ['failed', 'none', 'text-destructive', 'Linked - position sync failed. Rebuild it from this panel.'],
    ['ready', 'building', 'text-info', 'Linked - building the read-along...'],
    ['ready', 'failed', 'text-destructive', 'Linked - read-along build failed.'],
  ] as const)('narrates alignment %s and read-along %s on the trigger', (alignment, readAlong, tint, title) => {
    mockState.link.value = editionLinkRecord
    mockAlignment.status.value = alignment
    mockReadAlong.status.value = readAlong
    const wrapper = mountControl()

    expect(wrapper.find('button').find('svg').classes()).toContain(tint)
    expect(wrapper.find('button').attributes('title')).toBe(title)
  })

  it('leaves the trigger icon neutral without a link', () => {
    const wrapper = mountControl()

    expect(wrapper.find('button').find('svg').classes()).not.toContain('text-primary')
  })

  it('opens the panel, reloads the link and searches straight away when nothing was proposed', async () => {
    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(wrapper.find('[data-testid="link-edition-panel"]').exists()).toBe(true)
    expect(mockState.resetSearch).toHaveBeenCalled()
    expect(mockState.searchCandidates).toHaveBeenCalledWith('')
    expect(fetchLibraries).toHaveBeenCalled()
  })

  it('looks up an importable Storyteller book when a linked pair has no read-along yet', async () => {
    linkWithMembers()
    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(mockReadAlong.fetchExisting).toHaveBeenCalledWith(10)
  })

  it('does not look up Storyteller books once the read-along exists', async () => {
    linkWithMembers(
      makeMembers({
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
      }),
    )
    const wrapper = mountControl()
    await openPopover(wrapper)

    expect(mockReadAlong.fetchExisting).not.toHaveBeenCalled()
  })

  it('reloads the link once a read-along build finishes, so the new member shows', () => {
    mountControl()
    const handler = mockReadAlong.onReady.mock.calls[0]?.[0]
    mockState.loadForBook.mockClear()

    handler?.()

    expect(mockState.loadForBook).toHaveBeenCalled()
  })
})
