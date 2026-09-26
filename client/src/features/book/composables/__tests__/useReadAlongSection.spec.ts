import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type {
  Library,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '../useReadAlong'
import { useReadAlongSection } from '../useReadAlongSection'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission }),
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
  }
}

let readAlongState = createReadAlongState()

const libraryList = ref<Library[]>([])
const fetchLibraries = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: libraryList, fetchLibraries }),
}))

function makeLibrary(id: number, name: string, overrides: Partial<Library> = {}): Library {
  return { id, name, type: 'books', allowedFormats: [], ...overrides } as Library
}

vi.mock('../useReadAlong', () => ({
  useReadAlong: () => readAlongState,
}))

function makeMatch(overrides: Partial<StorytellerExistingMatch> = {}): StorytellerExistingMatch {
  return { uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94, ...overrides }
}

// useI18n needs an owning component, and the test setup installs the real English catalog, so the
// toasts below are asserted against the copy a user would actually read.
function mountSection(bookId = ref(10)) {
  let section!: ReturnType<typeof useReadAlongSection>
  const Host = defineComponent({
    setup() {
      section = useReadAlongSection(() => bookId.value)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { section, wrapper }
}

describe('useReadAlongSection', () => {
  beforeEach(() => {
    readAlongState = createReadAlongState()
    libraryList.value = []
    fetchLibraries.mockClear()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.info.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('hands the section the state slice it renders from', () => {
    readAlongState.status.value = 'building'
    readAlongState.phase.value = 'wait'
    readAlongState.transport.value = 'shared-paths'
    readAlongState.remoteTask.value = 'TRANSCRIBE_CHAPTERS'
    readAlongState.remoteProgress.value = 0.5
    readAlongState.targetLibraryName.value = 'Read-alongs'
    readAlongState.error.value = null

    const { section } = mountSection()

    expect(section.sectionState.value).toEqual({
      status: 'building',
      blocked: null,
      phase: 'wait',
      transport: 'shared-paths',
      remoteTask: 'TRANSCRIBE_CHAPTERS',
      remoteProgress: 0.5,
      targetLibraryName: 'Read-alongs',
      remoteCopyBytes: { epub: null, audio: null, readAlong: null },
      keepRemoteCopy: true,
      remoteCopyReclaimable: true,
      hasOutputBook: false,
      error: null,
      mutating: false,
    })
  })

  // A ready build the server described without its book is one this user cannot open, which the section
  // shows as out of reach rather than as something to build again.
  it('reports whether the server described the read-along book at all', async () => {
    const { section } = mountSection()
    expect(section.sectionState.value.hasOutputBook).toBe(false)

    readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
    await flushPromises()

    expect(section.sectionState.value.hasOutputBook).toBe(true)
  })

  it('offers only an aligned Storyteller book for import', async () => {
    readAlongState.existingMatches.value = [makeMatch({ uuid: 'uuid-unaligned', aligned: false })]
    const { section } = mountSection()
    expect(section.existingMatch.value).toBeNull()

    readAlongState.existingMatches.value = [makeMatch({ uuid: 'uuid-unaligned', aligned: false }), makeMatch({ uuid: 'uuid-aligned' })]
    await flushPromises()

    expect(section.existingMatch.value?.uuid).toBe('uuid-aligned')
  })

  it('gates generating and replacing on their own permissions', () => {
    permissionMocks.hasPermission.mockImplementation((name) => name === 'library_upload')
    const { section } = mountSection()

    expect(section.canGenerate.value).toBe(true)
    expect(section.canRebuild.value).toBe(false)
  })

  it.each([
    ['handleGenerate', {}],
    ['handleRetry', {}],
    ['handleRebuild', { force: true }],
  ] as const)('sends the request %s means', async (handler, expected) => {
    const { section } = mountSection()

    section[handler]()
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(10, expected)
  })

  it('imports the Storyteller book by its uuid', async () => {
    const { section } = mountSection()

    section.handleImportExisting('uuid-1')
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(10, { useExistingUuid: 'uuid-1' })
  })

  // The section narrates a build that started and a refusal it was given a reason for. The two outcomes
  // that leave the section exactly as it was have to be said out loud instead.
  it('narrates only the outcomes the section cannot show by itself', async () => {
    const { section } = mountSection()

    readAlongState.build.mockResolvedValue('started')
    await section.runBuild({})
    readAlongState.build.mockResolvedValue('blocked')
    await section.runBuild({})
    expect(toastMocks.error).not.toHaveBeenCalled()
    expect(toastMocks.info).not.toHaveBeenCalled()

    readAlongState.build.mockResolvedValue('failed')
    await section.runBuild({})
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to start the read-along build.')

    readAlongState.build.mockResolvedValue('ready')
    await section.runBuild({})
    expect(toastMocks.info).toHaveBeenCalledWith('This pair already has a read-along, so nothing was rebuilt.')
  })

  // One control instance can be reused for another book, so the id is read per build rather than
  // captured once: a stale id would build a read-along for the book the user just left.
  it('builds for the book the host is showing now', async () => {
    const bookId = ref(10)
    const { section } = mountSection(bookId)

    bookId.value = 11
    section.handleGenerate()
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(11, {})
  })

  it('cancels the build for the current book, and says so when the server cannot', async () => {
    const { section } = mountSection()

    await section.handleCancel()
    expect(readAlongState.cancel).toHaveBeenCalledWith(10)
    expect(toastMocks.error).not.toHaveBeenCalled()

    readAlongState.cancel.mockResolvedValue('failed')
    await section.handleCancel()
    expect(toastMocks.error).toHaveBeenCalledWith("The read-along build couldn't be cancelled.")
  })

  it('says the read-along is importing when the server refuses the cancel as too late', async () => {
    const { section } = mountSection()
    readAlongState.cancel.mockResolvedValue('too_late')

    await section.handleCancel()

    expect(toastMocks.error).toHaveBeenCalledWith("The read-along is being imported and can't be cancelled now.")
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
  })

  describe('destination choice', () => {
    beforeEach(() => {
      readAlongState.targetLibraryId.value = 4
      readAlongState.targetLibraryName.value = 'Read-alongs'
      libraryList.value = [
        makeLibrary(4, 'Read-alongs'),
        makeLibrary(5, 'Fiction'),
        makeLibrary(6, 'Audio only', { allowedFormats: ['m4b'] }),
        makeLibrary(7, 'Podcasts', { type: 'podcasts' }),
      ]
    })

    it('offers only libraries the build endpoint would accept', () => {
      const { section } = mountSection()

      expect(section.targetLibraries.value.map((library) => library.name)).toEqual(['Read-alongs', 'Fiction'])
    })

    it('describes the configured library until the user picks another, and names no library in the request', async () => {
      const { section } = mountSection()
      expect(section.chosenTargetLibraryId.value).toBeNull()
      expect(section.targetLibraryName.value).toBe('Read-alongs')

      section.handleGenerate()
      await flushPromises()
      expect(readAlongState.build).toHaveBeenLastCalledWith(10, {})

      section.setTargetLibrary(5)
      expect(section.targetLibraryName.value).toBe('Fiction')
      section.handleGenerate()
      await flushPromises()
      expect(readAlongState.build).toHaveBeenLastCalledWith(10, { targetLibraryId: 5 })
    })

    // The server answers reclaimability only for the configured library, so a different pick brings
    // the keep-copy choice back.
    it('offers the keep-copy choice again once another destination is picked', () => {
      readAlongState.remoteCopyReclaimable.value = false
      const { section } = mountSection()
      expect(section.keepCopyOffered.value).toBe(false)

      section.setTargetLibrary(5)
      expect(section.keepCopyOffered.value).toBe(true)
    })

    it('forgets the destination and keep-copy choices for a visit that starts over', () => {
      const { section } = mountSection()
      section.setTargetLibrary(5)

      section.resetChoices()

      expect(section.chosenTargetLibraryId.value).toBeNull()
      expect(section.targetLibraryName.value).toBe('Read-alongs')
      expect(readAlongState.resetKeepRemoteCopy).toHaveBeenCalled()
    })

    // Documents the current behaviour: the select cannot tell "the configured library, picked by name"
    // from any other pick, so choosing it sends its id like any other choice.
    it('sends the configured library id once it is picked by name', async () => {
      const { section } = mountSection()

      section.setTargetLibrary(4)
      section.handleGenerate()
      await flushPromises()

      expect(readAlongState.build).toHaveBeenLastCalledWith(10, { targetLibraryId: 4 })
    })

    it.each([
      ['handleGenerate', {}],
      ['handleRetry', {}],
      ['handleRebuild', { force: true }],
    ] as const)('honours a chosen destination from %s', async (handler, expected) => {
      const { section } = mountSection()
      section.setTargetLibrary(5)

      section[handler]()
      await flushPromises()

      expect(readAlongState.build).toHaveBeenCalledWith(10, { ...expected, targetLibraryId: 5 })
    })

    it('honours a chosen destination when importing a Storyteller book', async () => {
      const { section } = mountSection()
      section.setTargetLibrary(5)

      section.handleImportExisting('uuid-1')
      await flushPromises()

      expect(readAlongState.build).toHaveBeenCalledWith(10, { useExistingUuid: 'uuid-1', targetLibraryId: 5 })
    })

    it('loads the libraries on demand', () => {
      const { section } = mountSection()
      expect(fetchLibraries).not.toHaveBeenCalled()

      section.loadTargetLibraries()

      expect(fetchLibraries).toHaveBeenCalled()
    })
  })
})
