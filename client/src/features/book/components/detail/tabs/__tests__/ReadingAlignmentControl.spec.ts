import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { EditionLinkCounterpartSummary } from '@bookorbit/types'
import type { AlignmentStatus } from '../../../../composables/useReadingAlignment'
import type { EditionLink, EditionLinkCandidate } from '../../../../composables/useEditionLink'
import ReadingAlignmentControl from '../ReadingAlignmentControl.vue'

const toastMocks = vi.hoisted(() => ({ success: vi.fn<(...args: unknown[]) => void>(), error: vi.fn<(...args: unknown[]) => void>() }))
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

let alignmentState = createAlignmentState()
let editionLinkState = createEditionLinkState()

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
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    collections: [],
    ...overrides,
  }
}

function mountControl(overrides = {}) {
  return mount(ReadingAlignmentControl, { props: { book: makeBook(overrides) }, global: { stubs } })
}

describe('ReadingAlignmentControl', () => {
  beforeEach(() => {
    alignmentState = createAlignmentState()
    editionLinkState = createEditionLinkState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('renders nothing and never fetches when the book has no text or audio content files', async () => {
    const wrapper = mountControl({ files: [] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-hint"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(false)
    expect(alignmentState.fetchStatus).not.toHaveBeenCalled()
  })

  it('renders nothing for a text-only book with no edition link (the Link book control owns that prompt), but still loads the link', async () => {
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(editionLinkState.loadForBook).toHaveBeenCalledWith()
    expect(wrapper.find('[data-testid="alignment-hint"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(false)
  })

  it('renders nothing for an audio-only book with no edition link', async () => {
    const wrapper = mountControl({ files: [makeFile({ format: 'm4b', role: 'content' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-hint"]').exists()).toBe(false)
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    alignmentState.status.value = 'unalignable'
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-trigger"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="alignment-hint"]').exists()).toBe(false)
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
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
    editionLinkState.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    alignmentState.status.value = 'none'
    const wrapper = mountControl({ files: [makeFile({ format: 'epub' })] })
    await flushPromises()

    expect(wrapper.find('[data-testid="alignment-build-button"]').exists()).toBe(true)
  })
})
