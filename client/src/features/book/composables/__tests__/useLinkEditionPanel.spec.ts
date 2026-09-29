import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import type {
  BookDetail,
  EditionLinkCounterpartSummary,
  EditionLinkMembers,
  EditionLinkRole,
  ReadAlongBlockReason,
  ReadAlongOutputBook,
  ReadAlongPhase,
  ReadAlongStatus,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '../useEditionLink'
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '../useReadAlong'
import type { AlignmentStatus } from '../useReadingAlignment'
import { useLinkEditionPanel } from '../useLinkEditionPanel'

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

const calls: string[] = []

const linkRecord: EditionLink = { id: 1, textBookId: 10, audioBookId: 20, readAlongBookId: null, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }

function makeMembers(): EditionLinkMembers {
  return {
    text: {
      id: 10,
      title: 'Dune',
      authorName: 'Frank Herbert',
      coverVersion: null,
      progress: { percentage: 26, updatedAt: '2026-09-01' },
      narrationPercentage: null,
    },
    audio: { id: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, progress: null, narrationPercentage: null },
    readAlong: null,
  }
}

function createEditionLinkState() {
  const state = {
    link: ref<EditionLink | null>(null),
    proposed: ref<EditionLinkCandidate | null>(null),
    linkedCounterpart: ref<EditionLinkCounterpartSummary | null>(null),
    role: ref<EditionLinkRole | null>(null),
    members: ref<EditionLinkMembers | null>(null),
    readAlongOutput: ref(false),
    candidates: ref<EditionLinkCandidate[]>([]),
    loading: ref(false),
    searching: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    searchError: ref<string | null>(null),
    loadForBook: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    searchCandidates: vi.fn<(query: string) => Promise<EditionLinkCandidate[]>>().mockResolvedValue([]),
    linkBook: vi.fn<(id: number, sourceBookId?: number) => Promise<boolean>>(),
    unlink: vi.fn<() => Promise<boolean>>(),
    resetSearch: vi.fn<() => void>(),
  }
  state.linkBook.mockImplementation(async () => {
    calls.push('link')
    state.link.value = linkRecord
    state.role.value = 'text'
    state.members.value = makeMembers()
    return true
  })
  state.unlink.mockImplementation(async () => {
    calls.push('unlink')
    state.link.value = null
    state.role.value = null
    state.members.value = null
    state.readAlongOutput.value = false
    return true
  })
  return state
}

function createAlignmentState() {
  return {
    status: ref<AlignmentStatus>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    anchorCount: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildError: ref<string | null>(null),
    buildBlocked: ref<'disabled' | 'unavailable' | 'busy' | null>(null),
    fetchStatus: vi.fn<(id: number) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignmentStatus')
    }),
    build: vi.fn<(id: number, force?: boolean) => Promise<void>>().mockImplementation(async () => {
      calls.push('alignment')
    }),
    cancel: vi.fn<(id: number) => Promise<boolean>>().mockImplementation(async () => {
      calls.push('cancelAlignment')
      return true
    }),
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
    queuePosition: ref<number | null>(null),
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
    fetchStatus: vi.fn<(id: number) => Promise<void>>().mockImplementation(async () => {
      calls.push('readAlongStatus')
    }),
    build: vi.fn<() => Promise<ReadAlongBuildOutcome>>().mockImplementation(async () => {
      calls.push('readAlong')
      return 'started'
    }),
    cancel: vi.fn<(id: number) => Promise<ReadAlongCancelOutcome>>().mockResolvedValue('cancelled'),
    fetchExisting: vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
    reset: vi.fn<() => void>().mockImplementation(() => {
      calls.push('readAlongReset')
    }),
  }
}

let editionLinkState = createEditionLinkState()
let alignmentState = createAlignmentState()
let readAlongState = createReadAlongState()

vi.mock('../useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLinkState }
})
vi.mock('../useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('../useReadAlong', () => ({ useReadAlong: () => readAlongState }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))

function makeBook(format: 'epub' | 'm4b' = 'epub'): BookDetail {
  return {
    id: 10,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    files: [{ id: 1, format, role: 'content' }],
  } as unknown as BookDetail
}

const proposal: EditionLinkCandidate = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 }
const other: EditionLinkCandidate = { bookId: 21, title: 'Dune Messiah (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 41 }

function mountPanel(book = makeBook()) {
  let panel!: ReturnType<typeof useLinkEditionPanel>
  const Host = defineComponent({
    setup() {
      panel = useLinkEditionPanel(() => book)
      return () => null
    },
  })
  mount(Host)
  return panel
}

describe('useLinkEditionPanel', () => {
  beforeEach(() => {
    calls.length = 0
    editionLinkState = createEditionLinkState()
    alignmentState = createAlignmentState()
    readAlongState = createReadAlongState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('exposes the alignment build error for the position sync section', () => {
    const panel = mountPanel()
    expect(panel.alignment.buildError.value).toBeNull()

    alignmentState.buildError.value = 'whisper was killed by SIGILL'

    expect(panel.alignment.buildError.value).toBe('whisper was killed by SIGILL')
  })

  describe('phase', () => {
    it('is nomatch without a link or a candidate, and matched once the server proposes one', () => {
      const panel = mountPanel()
      expect(panel.phase.value).toBe('nomatch')

      editionLinkState.proposed.value = proposal
      expect(panel.phase.value).toBe('matched')
      expect(panel.selected.value).toEqual(proposal)
    })

    it('goes back to nomatch when the proposal is changed, and to matched on a pick', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.changeSelection()
      expect(panel.phase.value).toBe('nomatch')

      panel.selectCandidate(other)
      expect(panel.phase.value).toBe('matched')
      expect(panel.selected.value).toEqual(other)
    })

    it.each([
      ['pending', 'linking'],
      ['building', 'linking'],
      ['none', 'linked'],
      ['ready', 'linked'],
      ['failed', 'linked'],
      ['unalignable', 'linked'],
    ] as [AlignmentStatus, string][])('is %s alignment on a link made from the panel -> %s', async (status, expected) => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()

      alignmentState.status.value = status

      expect(panel.phase.value).toBe(expected)
    })

    it('counts a build request still in flight after linking as linking', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()

      alignmentState.mutating.value = true

      expect(panel.phase.value).toBe('linking')
    })

    it.each(['pending', 'building'] as AlignmentStatus[])('keeps a pair that has aligned before linked while it is %s again', (status) => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = status
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      alignmentState.mutating.value = true
      const panel = mountPanel()

      expect(panel.phase.value).toBe('linked')
    })

    it('is linking for a first build started from the other edition page', () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'building'
      const panel = mountPanel()

      expect(panel.phase.value).toBe('linking')
    })

    it('stays linked when position sync is rebuilt after the first alignment finished', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()
      alignmentState.status.value = 'building'
      expect(panel.phase.value).toBe('linking')

      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      alignmentState.status.value = 'building'

      expect(panel.phase.value).toBe('linked')
    })

    it('is still linking when the panel is reopened during a first build', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()
      alignmentState.status.value = 'building'

      await panel.handleOpen()

      expect(panel.phase.value).toBe('linking')
    })

    it('settles on linked once a relinked pair reads its existing alignment as ready', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()
      alignmentState.mutating.value = true
      expect(panel.phase.value).toBe('linking')

      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01T00:00:00.000Z'
      alignmentState.mutating.value = false

      expect(panel.phase.value).toBe('linked')
    })

    it('offers nothing on a read-along detached from its pair', () => {
      editionLinkState.readAlongOutput.value = true
      const panel = mountPanel()

      expect(panel.isEligible.value).toBe(false)
    })

    it('is linked and manageable on the read-along book page', () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.role.value = 'readAlong'
      alignmentState.status.value = 'building'
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      const panel = mountPanel()

      expect(panel.phase.value).toBe('linked')
      expect(panel.readAlongMode.value).toBe('manage')
    })

    it('is linking on the read-along book page during the first alignment, so sync off cancels it', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'building'
      const panel = mountPanel()

      expect(panel.phase.value).toBe('linking')
      await panel.endLink()
      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
    })

    it.each([
      ['nomatch', 'book.detail.editionLink.chip.noMatch', 'book.detail.editionLink.intro.noMatchAudiobook'],
      ['matched', 'book.detail.editionLink.chip.ready', 'book.detail.editionLink.intro.matched'],
    ])('keys the chip and intro for %s', (phase, chip, intro) => {
      if (phase === 'matched') editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(panel.chipKey.value).toBe(chip)
      expect(panel.introKey.value).toBe(intro)
    })

    it('shows a suggested match, without sections, to a viewer who cannot link', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_edit_metadata')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(panel.phase.value).toBe('matched')
      expect(panel.chipKey.value).toBe('book.detail.editionLink.chip.suggested')
      expect(panel.introKey.value).toBe('book.detail.editionLink.intro.matchedReadOnly')
      expect(panel.showSections.value).toBe(false)
    })

    it('hides the read-along offer from an editor who cannot generate one', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(panel.showSections.value).toBe(true)
      expect(panel.showReadAlong.value).toBe(false)
    })

    it.each([
      ['failed', null, 'book.detail.editionLink.intro.linkedUnsynced'],
      ['unalignable', null, 'book.detail.editionLink.intro.linkedUnsynced'],
      ['none', 'disabled', 'book.detail.editionLink.intro.linkedUnsynced'],
      ['none', 'unavailable', 'book.detail.editionLink.intro.linkedUnsynced'],
      ['none', 'busy', 'book.detail.editionLink.intro.linked'],
      ['ready', null, 'book.detail.editionLink.intro.linked'],
    ] as [AlignmentStatus, 'disabled' | 'unavailable' | 'busy' | null, string][])(
      'does not promise synced progress on a linked pair with alignment %s and block %s',
      (status, blocked, intro) => {
        editionLinkState.link.value = linkRecord
        alignmentState.status.value = status
        alignmentState.buildBlocked.value = blocked
        const panel = mountPanel()

        expect(panel.introKey.value).toBe(intro)
      },
    )
  })

  describe('loading', () => {
    it('shows the skeleton only until the first load resolves', async () => {
      const panel = mountPanel()
      editionLinkState.loading.value = true
      expect(panel.initialLoading.value).toBe(true)

      await panel.handleOpen()

      expect(panel.initialLoading.value).toBe(false)
    })
  })

  describe('slots', () => {
    it('puts the ebook above the audiobook, whichever page it is opened from', () => {
      editionLinkState.proposed.value = { ...proposal, bookId: 30 }
      const panel = mountPanel(makeBook('m4b'))

      const [top, bottom] = panel.slots.value
      expect(top).toMatchObject({
        kind: 'filled',
        format: 'ebook',
        bookId: 30,
        isThisBook: false,
        match: { source: 'auto', score: 96 },
        canChange: true,
      })
      expect(bottom).toMatchObject({ kind: 'filled', format: 'audiobook', bookId: 10, isThisBook: true })
    })

    it('turns the counterpart into a search slot without a candidate', () => {
      const panel = mountPanel()

      expect(panel.slots.value[1]).toEqual({ kind: 'search', format: 'audiobook' })
    })

    it('marks a picked candidate as selected rather than auto-matched', () => {
      const panel = mountPanel()
      panel.selectCandidate(other)

      expect(panel.slots.value[1]).toMatchObject({ bookId: 21, match: { source: 'manual' } })
    })

    it('reads a linked pair from the members, with progress', () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.role.value = 'text'
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel()

      expect(panel.slots.value[0]).toMatchObject({ bookId: 10, isThisBook: true, progress: 26, canChange: false })
      expect(panel.slots.value[1]).toMatchObject({ bookId: 20, isThisBook: false, progress: 0, match: null })
    })

    it('versions each cover: the current book from its detail, the others from their member or candidate', () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.role.value = 'text'
      editionLinkState.members.value = {
        ...makeMembers(),
        text: { ...makeMembers().text, coverVersion: 'member-text' },
        audio: { ...makeMembers().audio, coverVersion: '2026-03-01T00:00:00.000Z' },
      }
      const linked = mountPanel()

      expect(linked.slots.value[0]).toMatchObject({ bookId: 10, coverVersion: 'v1' })
      expect(linked.slots.value[1]).toMatchObject({ bookId: 20, coverVersion: '2026-03-01T00:00:00.000Z' })
    })

    it('versions a picked candidate cover from the candidate', () => {
      const panel = mountPanel()
      panel.selectCandidate({ ...other, coverVersion: '2026-04-01T00:00:00.000Z' })

      expect(panel.slots.value[1]).toMatchObject({ bookId: 21, coverVersion: '2026-04-01T00:00:00.000Z' })
    })

    it('never offers Change without the edit permission', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_edit_metadata')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(panel.slots.value[1]).toMatchObject({ canChange: false })
    })
  })

  describe('generating on link', () => {
    it('links without a read-along until one is toggled on', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.setSyncWanted(true)
      expect(panel.willGenerate.value).toBe(false)

      panel.setGenerateOnLink(true)
      expect(panel.willGenerate.value).toBe(true)
    })

    it('holds the read-along off while the pair is not wanted', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      expect(panel.toggleDisabled.value).toBe(true)
      expect(panel.willGenerate.value).toBe(false)
    })

    it('ignores the toggle once Storyteller is blocked for good', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      readAlongState.blocked.value = 'not_configured'

      expect(panel.toggleDisabled.value).toBe(true)
      expect(panel.willGenerate.value).toBe(false)
    })

    it('asks whether the matched pair already has a read-along, and asks again for another pick', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.handleOpen()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, 20)

      panel.selectCandidate({ bookId: 21, title: 'Dune (another)', authorName: null, coverVersion: null, score: 80 })
      await nextTick()

      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 21)
    })

    it('keeps the toggle usable while the pair simply does not exist yet', () => {
      readAlongState.blocked.value = 'no_pair'
      const panel = mountPanel()
      panel.setSyncWanted(true)

      expect(panel.toggleDisabled.value).toBe(false)
    })
  })

  describe('pending action', () => {
    it('starts with the switches matching the pair, so nothing is pending', async () => {
      editionLinkState.proposed.value = proposal
      const matched = mountPanel()
      expect(matched.syncWanted.value).toBe(false)
      expect(matched.pendingAction.value).toBeNull()

      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      await nextTick()
      expect(matched.syncWanted.value).toBe(true)
      expect(matched.pendingAction.value).toBeNull()
    })

    it('names the link, the link with a build, and runs it', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.setSyncWanted(true)
      expect(panel.pendingAction.value).toBe('link')
      panel.setGenerateOnLink(true)
      expect(panel.pendingAction.value).toBe('linkAndGenerate')

      await panel.runPendingAction()
      await flushPromises()
      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
    })

    it('names a build on an existing pair, and nothing once sync is switched off', () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      const linked = mountPanel()

      linked.setGenerateOnLink(true)
      expect(linked.pendingAction.value).toBe('generate')
      linked.setSyncWanted(false)
      expect(linked.generateOnLink.value).toBe(false)
      expect(linked.pendingAction.value).toBeNull()
    })

    it('ends a link in progress by cancelling it, and an established one by unlinking', async () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'building'
      const linking = mountPanel()

      await linking.endLink()
      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)

      editionLinkState.unlink.mockClear()
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      await nextTick()
      await linking.endLink()
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
    })

    it('offers no build on a pair whose read-along is already building', () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      readAlongState.status.value = 'building'
      const panel = mountPanel()

      panel.setGenerateOnLink(true)

      expect(panel.pendingAction.value).toBeNull()
    })

    it('keeps a read-along chosen during the first alignment once it finishes', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.setSyncWanted(true)
      await panel.startLink()
      alignmentState.status.value = 'building'
      await nextTick()
      expect(panel.phase.value).toBe('linking')
      panel.setGenerateOnLink(true)
      expect(panel.pendingAction.value).toBe('generate')

      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      await nextTick()

      expect(panel.phase.value).toBe('linked')
      expect(panel.generateOnLink.value).toBe(true)
      expect(panel.pendingAction.value).toBe('generate')
    })

    it('gives the read-along choice back when the unlink is not confirmed', () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      const panel = mountPanel()
      panel.setGenerateOnLink(true)
      panel.setSyncWanted(false)
      expect(panel.generateOnLink.value).toBe(false)

      panel.keepLink()

      expect(panel.syncWanted.value).toBe(true)
      expect(panel.generateOnLink.value).toBe(true)
      expect(panel.pendingAction.value).toBe('generate')
    })

    it('starts the choices over when the pair is unlinked', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      await panel.unlink()
      editionLinkState.proposed.value = proposal
      await nextTick()

      expect(panel.phase.value).toBe('matched')
      expect(panel.syncWanted.value).toBe(false)
      expect(panel.generateOnLink.value).toBe(false)
    })

    it('sets the switch back when an unlink is refused', async () => {
      editionLinkState.link.value = linkRecord
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      editionLinkState.unlink.mockResolvedValue(false)
      const panel = mountPanel()
      panel.setSyncWanted(false)

      await panel.endLink()

      expect(panel.syncWanted.value).toBe(true)
      expect(panel.pendingAction.value).toBeNull()
    })
  })

  describe('startLink', () => {
    beforeEach(() => {
      editionLinkState.proposed.value = proposal
    })

    it('links, then builds the alignment, then the read-along when toggled', async () => {
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      await panel.startLink()
      await flushPromises()

      expect(calls).toEqual(['link', 'alignment', 'readAlong'])
      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
      expect(toastMocks.success).toHaveBeenCalledWith('Books linked.')
    })

    it('builds only the alignment when the toggle is off', async () => {
      const panel = mountPanel()

      await panel.startLink()
      await flushPromises()

      expect(calls).toEqual(['link', 'alignment', 'readAlongStatus'])
    })

    it('reads the read-along status and Storyteller matches of the new pair when not generating', async () => {
      const panel = mountPanel()

      await panel.startLink()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
    })

    it('reads only the status of the new pair without the upload permission', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      const panel = mountPanel()

      await panel.startLink()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchExisting).not.toHaveBeenCalled()
    })

    it('links the picked candidate instead of the proposal', async () => {
      const panel = mountPanel()
      panel.selectCandidate(other)

      await panel.startLink()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(21, 10)
    })

    it('never builds a read-along without the upload permission', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      await panel.startLink()
      await flushPromises()

      expect(calls).toEqual(['link', 'alignment', 'readAlongStatus'])
    })

    it('builds nothing when the link fails', async () => {
      editionLinkState.linkBook.mockResolvedValue(false)
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      await panel.startLink()

      expect(alignmentState.build).not.toHaveBeenCalled()
      expect(readAlongState.build).not.toHaveBeenCalled()
      expect(toastMocks.error).toHaveBeenCalledWith('Failed to link book.')
    })

    it('acts on the pair a read-along page linked, even when the reload no longer names it', async () => {
      editionLinkState.proposed.value = null
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers()
      editionLinkState.linkBook.mockImplementation(async () => {
        editionLinkState.link.value = null
        editionLinkState.role.value = null
        editionLinkState.members.value = null
        editionLinkState.readAlongOutput.value = true
        return true
      })
      const panel = mountPanel({ ...makeBook(), id: 30 } as BookDetail)

      await panel.startLink()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10)
      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
    })

    it('does nothing without a selected candidate', async () => {
      const panel = mountPanel()
      panel.changeSelection()

      await panel.startLink()

      expect(editionLinkState.linkBook).not.toHaveBeenCalled()
    })
  })

  describe('cancelLinking', () => {
    it('unlinks and returns to matched with the picked counterpart still selected', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.selectCandidate(other)
      editionLinkState.linkBook.mockImplementationOnce(async () => {
        editionLinkState.link.value = linkRecord
        editionLinkState.role.value = 'text'
        editionLinkState.members.value = { ...makeMembers(), audio: { ...makeMembers().audio, id: 21, title: 'Dune Messiah (audio)' } }
        return true
      })
      await panel.startLink()
      alignmentState.status.value = 'building'
      expect(panel.phase.value).toBe('linking')

      await panel.cancelLinking()

      expect(editionLinkState.unlink).toHaveBeenCalled()
      expect(panel.phase.value).toBe('matched')
      expect(panel.selected.value?.bookId).toBe(21)
      expect(panel.slots.value[1]).toMatchObject({ match: { source: 'manual' } })
    })

    it('keeps the auto-match chip when the linked counterpart was the proposal', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()
      alignmentState.status.value = 'building'

      await panel.cancelLinking()

      expect(panel.phase.value).toBe('matched')
      expect(panel.slots.value[1]).toMatchObject({ bookId: 20, match: { source: 'auto', score: 96 } })
    })

    it('stops a running read-along build first, and still unlinks when that is refused, saying the build keeps running', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      editionLinkState.role.value = 'text'
      alignmentState.status.value = 'building'
      readAlongState.status.value = 'building'
      readAlongState.cancel.mockImplementation(async () => {
        calls.push('cancelReadAlong')
        return 'failed'
      })
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(readAlongState.cancel).toHaveBeenCalledWith(10)
      expect(calls.slice(0, 3)).toEqual(['cancelReadAlong', 'cancelAlignment', 'unlink'])
      expect(toastMocks.error).toHaveBeenCalledWith("The read-along build couldn't be cancelled and keeps running on Storyteller.")
    })

    it('cancels the read-along first, then the position sync, then unlinks', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'building'
      readAlongState.status.value = 'building'
      readAlongState.cancel.mockImplementation(async () => {
        calls.push('cancelReadAlong')
        return 'cancelled'
      })
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(calls.slice(0, 3)).toEqual(['cancelReadAlong', 'cancelAlignment', 'unlink'])
      expect(toastMocks.error).not.toHaveBeenCalled()
    })

    it('keeps the link when the read-along is already being imported, and says why', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'building'
      readAlongState.status.value = 'building'
      readAlongState.cancel.mockImplementation(async () => {
        calls.push('cancelReadAlong')
        return 'too_late'
      })
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(calls).toEqual(['cancelReadAlong'])
      expect(alignmentState.cancel).not.toHaveBeenCalled()
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
      expect(toastMocks.error).toHaveBeenCalledExactlyOnceWith("The read-along is being imported and can't be cancelled now.")
    })

    it('cancels neither build when nothing is running', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(readAlongState.cancel).not.toHaveBeenCalled()
      expect(alignmentState.cancel).not.toHaveBeenCalled()
      expect(editionLinkState.unlink).toHaveBeenCalled()
    })

    it('says the position sync keeps running when its cancel is refused, and still unlinks', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'building'
      alignmentState.cancel.mockImplementation(async () => {
        calls.push('cancelAlignment')
        return false
      })
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(calls.slice(0, 2)).toEqual(['cancelAlignment', 'unlink'])
      expect(toastMocks.error).toHaveBeenCalledWith("The position sync build couldn't be cancelled and keeps running.")
    })

    it('also tries to stop a read-along build request that is still in flight', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      readAlongState.mutating.value = true
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(readAlongState.cancel).toHaveBeenCalledWith(10)
      expect(toastMocks.error).not.toHaveBeenCalled()
    })

    it('forgets the cancelled pair before reading the statuses again', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(calls.slice(0, 4)).toEqual(['unlink', 'readAlongReset', 'alignmentStatus', 'readAlongStatus'])
      expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 20)
    })

    it('leaves the read-along alone when none is building', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'building'
      const panel = mountPanel()

      await panel.cancelLinking()

      expect(readAlongState.cancel).not.toHaveBeenCalled()
    })

    it('stays linking and says so when the unlink fails', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.startLink()
      alignmentState.status.value = 'building'
      editionLinkState.unlink.mockResolvedValue(false)

      await panel.cancelLinking()

      expect(panel.phase.value).toBe('linking')
      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't cancel linking.")
    })
  })

  describe('a relinked pair whose read-along still exists', () => {
    it('reloads the link once when the status names a read-along the members lack', async () => {
      editionLinkState.proposed.value = proposal
      mountPanel()
      await editionLinkState.linkBook(20)
      editionLinkState.loadForBook.mockClear()

      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = 'ready'
      await flushPromises()
      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)

      readAlongState.status.value = 'none'
      await flushPromises()
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = 'ready'
      await flushPromises()
      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
    })

    it('does not reload once the member is there', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = {
        ...makeMembers(),
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
      }
      mountPanel()

      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = 'ready'
      await flushPromises()

      expect(editionLinkState.loadForBook).not.toHaveBeenCalled()
    })
  })

  // A rebuild keeps the previous read-along on its build row, so the status names a book while the new
  // one is still running or after it failed.
  describe('a build row naming the previous read-along', () => {
    it.each(['queued', 'building', 'failed'] as ReadAlongStatus[])('never reads a %s build as the pair having one', async (status) => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      const panel = mountPanel()

      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = status
      await flushPromises()

      expect(panel.readAlongMember.value).toBeNull()
      expect(panel.readAlongSlot.value).toBeNull()
      expect(editionLinkState.loadForBook).not.toHaveBeenCalled()
    })

    it.each(['building', 'failed'] as ReadAlongStatus[])('keeps the linked read-along as the third stop while a rebuild is %s', (status) => {
      editionLinkState.link.value = { ...linkRecord, readAlongBookId: 30 }
      editionLinkState.members.value = {
        ...makeMembers(),
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
      }
      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-01-01'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = status
      const panel = mountPanel()

      expect(panel.readAlongSlot.value).toMatchObject({ bookId: 30, readAlong: true })
    })

    it('still offers a build before a link when the named read-along only belongs to a failed build', () => {
      editionLinkState.proposed.value = proposal
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      readAlongState.status.value = 'failed'
      const panel = mountPanel()
      panel.setSyncWanted(true)
      panel.setGenerateOnLink(true)

      expect(panel.pendingAction.value).toBe('linkAndGenerate')
    })
  })

  describe('unlink', () => {
    it('forgets the unlinked pair before reading the statuses again', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel()

      await panel.unlink()

      expect(calls.slice(0, 4)).toEqual(['unlink', 'readAlongReset', 'alignmentStatus', 'readAlongStatus'])
      expect(toastMocks.success).toHaveBeenCalledWith('Books unlinked.')
    })

    // The real unlink reloads the for-book state, whose proposal is the pair just unlinked. The status
    // read after it must ask about that pair, or a surviving read-along is offered as a new build.
    it('reads the status of the pair it restores, so a surviving read-along is not offered again', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.members.value = makeMembers()
      editionLinkState.unlink.mockImplementation(async () => {
        editionLinkState.link.value = null
        editionLinkState.role.value = null
        editionLinkState.members.value = null
        editionLinkState.proposed.value = proposal
        return true
      })
      const panel = mountPanel()

      await panel.unlink()
      await flushPromises()

      expect(panel.selected.value?.bookId).toBe(20)
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 20)
      expect(readAlongState.fetchStatus).not.toHaveBeenCalledWith(10)
    })

    it('keeps everything it read when the unlink fails', async () => {
      editionLinkState.link.value = linkRecord
      editionLinkState.unlink.mockResolvedValue(false)
      const panel = mountPanel()

      await panel.unlink()

      expect(readAlongState.reset).not.toHaveBeenCalled()
      expect(alignmentState.fetchStatus).not.toHaveBeenCalled()
    })
  })

  describe('opening', () => {
    it('forgets a previous toggle and searches straight away when nothing was proposed', async () => {
      const panel = mountPanel()
      panel.setGenerateOnLink(true)

      await panel.handleOpen()

      expect(panel.generateOnLink.value).toBe(false)
      expect(readAlongState.resetKeepRemoteCopy).toHaveBeenCalled()
      expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('')
      expect(panel.hasSearched.value).toBe(true)
    })

    it('does not search when the server proposed a match', async () => {
      editionLinkState.loadForBook.mockImplementation(async () => {
        editionLinkState.proposed.value = proposal
      })
      const panel = mountPanel()

      await panel.handleOpen()

      expect(editionLinkState.searchCandidates).not.toHaveBeenCalled()
      expect(panel.phase.value).toBe('matched')
    })

    it('loads the results again when the selection is changed', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.changeSelection()

      expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('')
    })

    it('focuses the search only when it appears through Change', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      expect(panel.searchAutofocus.value).toBe(false)

      panel.changeSelection()
      expect(panel.searchAutofocus.value).toBe(true)

      panel.selectCandidate(other)
      expect(panel.searchAutofocus.value).toBe(false)

      panel.changeSelection()
      await panel.handleOpen()
      expect(panel.searchAutofocus.value).toBe(false)
    })
  })

  describe('trigger', () => {
    it.each([
      ['building', 'none', 'text-info'],
      ['ready', 'building', 'text-info'],
      ['ready', 'queued', 'text-info'],
      ['failed', 'none', 'text-destructive'],
      ['ready', 'failed', 'text-destructive'],
      ['ready', 'none', 'text-success'],
      ['none', 'none', 'text-primary'],
    ] as [AlignmentStatus, ReadAlongStatus, string][])(
      'tints the icon for alignment %s and read-along %s as %s',
      (alignment, readAlong, expected) => {
        editionLinkState.link.value = linkRecord
        alignmentState.status.value = alignment
        readAlongState.status.value = readAlong
        const panel = mountPanel()

        expect(panel.triggerIconClass.value).toBe(expected)
      },
    )

    it('names a queued read-along as queued in the tooltip, not as building', () => {
      editionLinkState.link.value = linkRecord
      readAlongState.status.value = 'queued'
      const panel = mountPanel()

      expect(panel.triggerTooltip.value).toBe('Linked - read-along queued.')
    })

    it('leaves the icon neutral and names position sync before a link exists', () => {
      const panel = mountPanel()

      expect(panel.triggerIconClass.value).toBe('')
      expect(panel.triggerTooltip.value).toBe('Link an audiobook to enable position sync.')
    })
  })
})
