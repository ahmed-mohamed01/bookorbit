import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type {
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { ReadAlongBuildOutcome } from '../useReadAlong'
import { useReadAlongRow } from '../useReadAlongRow'

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
    fetchExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
  }
}

let readAlongState = createReadAlongState()

vi.mock('../useReadAlong', () => ({
  useReadAlong: () => readAlongState,
}))

function makeMatch(overrides: Partial<StorytellerExistingMatch> = {}): StorytellerExistingMatch {
  return { uuid: 'uuid-1', title: 'Forward the Foundation', authors: ['Isaac Asimov'], aligned: true, score: 94, ...overrides }
}

// useI18n needs an owning component, and the test setup installs the real English catalog, so the
// toasts below are asserted against the copy a user would actually read.
function mountRow(bookId = ref(10)) {
  let row!: ReturnType<typeof useReadAlongRow>
  const Host = defineComponent({
    setup() {
      row = useReadAlongRow(() => bookId.value)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { row, wrapper }
}

describe('useReadAlongRow', () => {
  beforeEach(() => {
    readAlongState = createReadAlongState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.info.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('hands the row the state slice it renders from', () => {
    readAlongState.status.value = 'building'
    readAlongState.phase.value = 'wait'
    readAlongState.transport.value = 'shared-paths'
    readAlongState.remoteTask.value = 'TRANSCRIBE_CHAPTERS'
    readAlongState.remoteProgress.value = 0.5
    readAlongState.targetLibraryName.value = 'Read-alongs'
    readAlongState.error.value = null

    const { row } = mountRow()

    expect(row.rowState.value).toEqual({
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

  // A ready build the server described without its book is one this user cannot open, which the row
  // shows as out of reach rather than as something to build again.
  it('reports whether the server described the read-along book at all', async () => {
    const { row } = mountRow()
    expect(row.rowState.value.hasOutputBook).toBe(false)

    readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
    await flushPromises()

    expect(row.rowState.value.hasOutputBook).toBe(true)
  })

  it('offers only an aligned Storyteller book for import', async () => {
    readAlongState.existingMatches.value = [makeMatch({ uuid: 'uuid-unaligned', aligned: false })]
    const { row } = mountRow()
    expect(row.existingMatch.value).toBeNull()

    readAlongState.existingMatches.value = [makeMatch({ uuid: 'uuid-unaligned', aligned: false }), makeMatch({ uuid: 'uuid-aligned' })]
    await flushPromises()

    expect(row.existingMatch.value?.uuid).toBe('uuid-aligned')
  })

  it('gates generating and replacing on their own permissions', () => {
    permissionMocks.hasPermission.mockImplementation((name) => name === 'library_upload')
    const { row } = mountRow()

    expect(row.canGenerate.value).toBe(true)
    expect(row.canRebuild.value).toBe(false)
  })

  it.each([
    ['handleGenerate', {}],
    ['handleRetry', {}],
    ['handleRebuild', { force: true }],
  ] as const)('sends the request %s means', async (handler, expected) => {
    const { row } = mountRow()

    row[handler]()
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(10, expected)
  })

  it('imports the Storyteller book by its uuid', async () => {
    const { row } = mountRow()

    row.handleImportExisting('uuid-1')
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(10, { useExistingUuid: 'uuid-1' })
  })

  // The row narrates a build that started and a refusal it was given a reason for. The two outcomes
  // that leave the row exactly as it was have to be said out loud instead.
  it('narrates only the outcomes the row cannot show by itself', async () => {
    const { row } = mountRow()

    readAlongState.build.mockResolvedValue('started')
    await row.runBuild({})
    readAlongState.build.mockResolvedValue('blocked')
    await row.runBuild({})
    expect(toastMocks.error).not.toHaveBeenCalled()
    expect(toastMocks.info).not.toHaveBeenCalled()

    readAlongState.build.mockResolvedValue('failed')
    await row.runBuild({})
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to start the read-along build.')

    readAlongState.build.mockResolvedValue('ready')
    await row.runBuild({})
    expect(toastMocks.info).toHaveBeenCalledWith('This pair already has a read-along, so nothing was rebuilt.')
  })

  // One control instance can be reused for another book, so the id is read per build rather than
  // captured once: a stale id would build a read-along for the book the user just left.
  it('builds for the book the host is showing now', async () => {
    const bookId = ref(10)
    const { row } = mountRow(bookId)

    bookId.value = 11
    row.handleGenerate()
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(11, {})
  })
})
