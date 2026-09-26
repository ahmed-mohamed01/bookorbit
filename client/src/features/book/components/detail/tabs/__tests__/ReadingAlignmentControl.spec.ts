import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, defineComponent } from 'vue'
import type {
  EditionLinkCounterpartSummary,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { AlignmentStatus } from '../../../../composables/useReadingAlignment'
import type { EditionLink, EditionLinkCandidate } from '../../../../composables/useEditionLink'
import type { ReadAlongBuildOutcome } from '../../../../composables/useReadAlong'
import ReadingAlignmentControl from '../ReadingAlignmentControl.vue'

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

function createAlignmentState() {
  return {
    status: ref<AlignmentStatus>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    anchorCount: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    loading: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildBlocked: ref<'disabled' | 'unavailable' | 'busy' | null>(null),
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
}

function createEditionLinkState() {
  return {
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    candidates: ref<EditionLinkCandidate[]>([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    loadForBook: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    searchCandidates: vi.fn<() => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
    linkBook: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    unlink: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resetSearch: vi.fn<() => void>(),
  }
}

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

let alignmentState = createAlignmentState()
let editionLinkState = createEditionLinkState()
let readAlongState = createReadAlongState()

// The state composable is the only faked half. useReadAlongRow, the shared row wiring both hosts
// call, is the real one here and derives everything it hands the row from this mock.
vi.mock('@/features/book/composables/useReadAlong', () => ({
  useReadAlong: () => readAlongState,
}))

vi.mock('@/features/book/composables/useReadingAlignment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useReadingAlignment')>()
  return { ...actual, useReadingAlignment: () => alignmentState }
})

vi.mock('@/features/book/composables/useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLinkState }
})

const stubs = {
  Popover: { name: 'Popover', props: ['open'], emits: ['update:open'], template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>' },
  PopoverContent: { template: '<div><slot /></div>' },
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
}

function makeFile(overrides: Partial<{ id: number; format: string | null; role: string }> = {}) {
  return {
    id: 1,
    format: 'epub',
    role: 'content',
    sizeBytes: 100,
    absolutePath: '/b.epub',
    createdAt: '2026-01-01',
    filename: 'b.epub',
    durationSeconds: null,
    ...overrides,
  }
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
    files: [makeFile()],
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
  return mount(ReadingAlignmentControl, { props: { book: makeBook(overrides) }, global: { stubs: { ...stubs, ConfirmDialog: ConfirmDialogStub } } })
}

describe('ReadingAlignmentControl', () => {
  beforeEach(() => {
    alignmentState = createAlignmentState()
    editionLinkState = createEditionLinkState()
    readAlongState = createReadAlongState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.info.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('renders nothing and never fetches when the book has no text or audio content files', async () => {
    const wrapper = mountControl({ files: [] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(false)
    expect(alignmentState.fetchStatus).not.toHaveBeenCalled()
  })

  it('renders nothing for a text-only book with no edition link (the Link book control owns that prompt), but still loads the link', async () => {
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(editionLinkState.loadForBook).toHaveBeenCalledWith()
    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(false)
  })

  it('renders nothing for an audio-only book with no edition link', async () => {
    const wrapper = mountControl({ files: [makeFile({ format: 'm4b', role: 'content' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(false)
  })

  it('fetches status on mount and renders the trigger for a self-contained dual-format book', async () => {
    alignmentState.status.value = 'ready'
    const wrapper = mountControl({
      files: [makeFile({ format: 'epub' }), makeFile({ id: 2, format: 'm4b', role: 'content' })],
    })
    await flushPromises()

    expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
    expect(editionLinkState.loadForBook).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Aligned')
  })

  it('surfaces a linked-but-unalignable pair as a real status control, explains it in the popover, and offers a rebuild button', async () => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'unalignable'
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="alignment-unalignable"]').text()).toContain("isn't available")
    // 'unalignable' can be a retryable cause (since-fixed missing duration / bad model), so a rebuild path is offered.
    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(true)
  })

  it('shows build progress and anchor count while building', async () => {
    alignmentState.status.value = 'building'
    alignmentState.samplesDone.value = 3
    alignmentState.samplesTotal.value = 12
    alignmentState.anchorCount.value = 2
    const wrapper = mountControl({
      files: [makeFile({ format: 'epub' }), makeFile({ id: 2, format: 'm4b', role: 'content' })],
    })
    await flushPromises()

    const building = wrapper.find('[data-testid="alignment-building"]')
    expect(building.text()).toContain('3 / 12 samples')
    expect(building.text()).toContain('2 anchors found')
    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(false)
  })

  it('shows a rebuild button and builtAt when ready, and calls build with force=true on click', async () => {
    alignmentState.status.value = 'ready'
    alignmentState.anchorCount.value = 5
    alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
    const wrapper = mountControl({
      files: [makeFile({ format: 'epub' }), makeFile({ id: 2, format: 'm4b', role: 'content' })],
    })
    await flushPromises()

    const ready = wrapper.find('[data-testid="alignment-ready"]')
    expect(ready.text()).toContain('5 anchors found')
    const button = wrapper.find('[data-testid="alignment-build-button"]')
    expect(button.text()).toContain('Rebuild alignment')

    await button.trigger('click')
    await flushPromises()

    expect(alignmentState.build).toHaveBeenCalledWith(10, true)
  })

  it('shows a build button for a linked pair that has never been built, and calls build with force=false', async () => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'none'
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    const button = wrapper.find('[data-testid="alignment-build-button"]')
    expect(button.text()).toContain('Build alignment')

    await button.trigger('click')
    await flushPromises()

    expect(alignmentState.build).toHaveBeenCalledWith(10, false)
  })

  it('shows an error toast when the build call leaves an error set', async () => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'none'
    alignmentState.build.mockImplementation(async () => {
      alignmentState.error.value = 'Failed to start alignment build'
    })
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    await wrapper.find('[data-testid="alignment-build-button"]').trigger('click')
    await flushPromises()

    expect(toastMocks.error).toHaveBeenCalled()
  })

  // Regression guard for the UI->service contract: a 'failed' rebuild MUST NOT force, or the build
  // service can never resume an interrupted build (it restarts from sample 0). Only 'ready' forces.
  it.each([
    ['ready', true],
    ['failed', false],
    ['unalignable', false],
  ] as const)('builds a %s alignment with force=%s (failed must resume, not force-restart)', async (status, expectedForce) => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = status
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    await wrapper.find('[data-testid="alignment-build-button"]').trigger('click')
    await flushPromises()

    expect(alignmentState.build).toHaveBeenCalledWith(expect.any(Number), expectedForce)
  })

  it.each([
    ['disabled', 'turned off'],
    ['unavailable', "isn't configured"],
  ] as const)('hides the build button entirely for a terminal %s block', async (reason, expectedText) => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'none'
    alignmentState.build.mockImplementation(async () => {
      alignmentState.buildBlocked.value = reason
    })
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    await wrapper.find('[data-testid="alignment-build-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-build-blocked"]').text()).toContain(expectedText)
    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="alignment-building"]').exists()).toBe(false)
  })

  it('keeps the build button visible so a busy block can be retried', async () => {
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'none'
    alignmentState.build.mockImplementationOnce(async () => {
      alignmentState.buildBlocked.value = 'busy'
    })
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    await wrapper.find('[data-testid="alignment-build-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-build-blocked"]').text()).toContain('busy')
    const retryButton = wrapper.find('[data-testid="alignment-build-button"]')
    expect(retryButton.exists()).toBe(true)

    alignmentState.build.mockImplementationOnce(async () => {
      alignmentState.buildBlocked.value = null
    })
    await retryButton.trigger('click')
    await flushPromises()

    expect(alignmentState.build).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="alignment-build-blocked"]').exists()).toBe(false)
  })

  it('hides the build button without library_edit_metadata permission, even when ready to rebuild', async () => {
    permissionMocks.hasPermission.mockReturnValue(false)
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'ready'
    const wrapper = mountControl({
      files: [makeFile({ format: 'epub' }), makeFile({ id: 2, format: 'm4b', role: 'content' })],
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="alignment-ready"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(false)
  })

  it('shows the build button once library_edit_metadata is granted', async () => {
    permissionMocks.hasPermission.mockReturnValue(true)
    editionLinkState.link.value = {
      id: 1,
      textBookId: 10,
      audioBookId: 20,
      readAlongBookId: null,
      createdBy: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    alignmentState.status.value = 'none'
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(true)
  })

  describe('read-along row for a self-pair', () => {
    function mountSelfPair() {
      return mountControl({ files: [makeFile({ format: 'epub' }), makeFile({ id: 2, format: 'm4b', role: 'content' })] })
    }

    async function openPopover(wrapper: ReturnType<typeof mountControl>) {
      await wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', true)
      await flushPromises()
    }

    it('hosts the row and reads its status on mount', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10)
      expect(wrapper.find('[data-testid="read-along-row"]').exists()).toBe(true)
    })

    it('generates and rebuilds through the row', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})

      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-row"]').text()).toContain('Dune (read-along)')
      await wrapper.find('[data-testid="read-along-rebuild"]').trigger('click')
      await confirmRebuild(wrapper)
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, { force: true })
    })

    it('shows how the files reach Storyteller while the build runs', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      readAlongState.status.value = 'building'
      readAlongState.phase.value = 'process'
      readAlongState.transport.value = 'api-transfer'
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-destination"]').attributes('aria-label')).toContain('uploaded to Storyteller')
    })

    it('says the read-along exists rather than offering to build it again when its book is masked', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      // A ready build the server described without an output book: it lives in a library this user
      // cannot open, and every build action on it would be refused.
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = null
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-out-of-reach"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
    })

    it('narrates a build that was accepted without starting anything', async () => {
      readAlongState.build.mockResolvedValue('ready')

      const wrapper = mountSelfPair()
      await flushPromises()

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()

      expect(toastMocks.info).toHaveBeenCalledWith('This pair already has a read-along, so nothing was rebuilt.')
      expect(toastMocks.error).not.toHaveBeenCalled()
    })

    it('reports a build request that the server refused', async () => {
      readAlongState.build.mockResolvedValue('failed')

      const wrapper = mountSelfPair()
      await flushPromises()

      await wrapper.find('[data-testid="read-along-generate"]').trigger('click')
      await flushPromises()

      expect(toastMocks.error).toHaveBeenCalledWith('Failed to start the read-along build.')
    })

    it('hands the keep-copy choice to the composable', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      await wrapper.get('[data-testid="read-along-keep-copy"]').trigger('click')

      expect(readAlongState.setKeepRemoteCopy).toHaveBeenCalledWith(false)
    })

    it('shows a block the server reports while the build row is ready', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.blocked.value = 'previous_output_not_deletable'
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-blocked"]').text()).toContain('permission to delete books')
      expect(wrapper.find('[data-testid="read-along-rebuild"]').attributes('disabled')).toBeDefined()
    })

    it('looks up existing Storyteller matches when the popover opens without an output book', async () => {
      const wrapper = mountSelfPair()
      await flushPromises()

      await openPopover(wrapper)

      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
    })

    // The Link popover shows the read-along row to anyone who can open the book and lets the row gate
    // its own actions. A self-pair is the same book, so hiding it here would mean a reader on a
    // dual-format title never learns a read-along exists.
    it('shows the row without the upload permission, but offers no actions', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')

      const wrapper = mountSelfPair()
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-row"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-rebuild"]').exists()).toBe(false)
    })

    it('leaves the row to the Link popover for a linked pair', async () => {
      editionLinkState.link.value = {
        id: 1,
        textBookId: 10,
        audioBookId: 20,
        readAlongBookId: null,
        createdBy: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      }

      const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
      await flushPromises()

      expect(wrapper.find('[data-testid="read-along-row"]').exists()).toBe(false)
      expect(readAlongState.fetchStatus).not.toHaveBeenCalled()
    })
  })
})
