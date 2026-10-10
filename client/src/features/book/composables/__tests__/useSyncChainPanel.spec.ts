import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import type { AudiobookshelfBookState, AudiobookshelfBookSyncLink, BookDetail, EditionLinkMember, ReadAloudProgressSync } from '@bookorbit/types'
import type { ChainAvailableRow, ChainCardRow, ChainConnectorRow, ConnectorKey } from '@/features/book/lib/sync-chain'
import { AudiobookshelfReconcileError } from '@/features/audiobookshelf/api/audiobookshelf.api'
import type { EditionLinkCandidate } from '../useEditionLink'
import { useSyncChainPanel } from '../useSyncChainPanel'
import {
  calls,
  createAbsState,
  createAlignmentState,
  createEditionLinkState,
  createReadAlongState,
  linkRecord,
  makeMembers,
  member,
} from './sync-chain-panel-mocks'

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

const absApiMocks = vi.hoisted(() => ({
  reconcile: vi.fn<(id: string, direction: string) => Promise<unknown>>(),
  exclusion: vi.fn<(id: string, excluded: boolean) => Promise<unknown>>(),
  confirm: vi.fn<(id: string) => Promise<unknown>>(),
  link: vi.fn<(id: string, bookId: number) => Promise<unknown>>(),
  unlink: vi.fn<(id: string) => Promise<unknown>>(),
}))
vi.mock('@/features/audiobookshelf/api/audiobookshelf.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/audiobookshelf/api/audiobookshelf.api')>()),
  reconcileAudiobookshelfPosition: absApiMocks.reconcile,
  updateAudiobookshelfBookExclusion: absApiMocks.exclusion,
  confirmAudiobookshelfMatch: absApiMocks.confirm,
  linkAudiobookshelfBook: absApiMocks.link,
  unlinkAudiobookshelfBook: absApiMocks.unlink,
}))

let editionLinkState = createEditionLinkState()
let alignmentState = createAlignmentState()
let readAlongState = createReadAlongState()
let absState = createAbsState()

vi.mock('../useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLinkState }
})
vi.mock('../useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('../useReadAlong', () => ({ useReadAlong: () => readAlongState }))
vi.mock('../useAudiobookshelfSyncLink', async () => {
  const { watch } = await import('vue')
  return {
    useAudiobookshelfSyncLink: (audioBookId: import('vue').Ref<number | null>) => {
      watch(audioBookId, (id) => absState.audioBookIds.push(id), { immediate: true })
      return absState
    },
  }
})
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))

const noIssue: ReadAloudProgressSync = {
  mode: 'auto',
  state: 'unavailable',
  unavailableReason: 'no_media_overlay_epub',
  overlayFileId: null,
  audioDurationSeconds: null,
  overlayDurationSeconds: null,
  durationDifferenceSeconds: null,
  durationDifferenceRatio: null,
  koreaderDownloadAvailable: false,
  narrationMismatch: null,
  offsetsSource: null,
}

function makeBook(format: 'epub' | 'm4b' = 'epub', id = 10, readAloudSync: ReadAloudProgressSync = noIssue): BookDetail {
  return {
    id,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    files: [{ id: 1, format, role: 'content' }],
    readAloudSync,
  } as unknown as BookDetail
}

const proposal: EditionLinkCandidate = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 }
const other: EditionLinkCandidate = { bookId: 21, title: 'Dune Messiah (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 41 }

function mountPanel(book = makeBook()) {
  let panel!: ReturnType<typeof useSyncChainPanel>
  mount(
    defineComponent({
      setup() {
        panel = useSyncChainPanel(() => book)
        return () => null
      },
    }),
  )
  return panel
}

function linkPairState(readAlong: EditionLinkMember | null = null) {
  editionLinkState.link.value = readAlong ? { ...linkRecord, readAlongBookId: readAlong.id } : linkRecord
  editionLinkState.role.value = 'text'
  editionLinkState.members.value = makeMembers(readAlong)
}

function alignedPair(readAlong: EditionLinkMember | null = null) {
  linkPairState(readAlong)
  alignmentState.status.value = 'ready'
  alignmentState.builtAt.value = '2026-10-01T00:00:00.000Z'
}

function connector(panel: ReturnType<typeof useSyncChainPanel>, key: ConnectorKey): ChainConnectorRow {
  const row = panel.chain.value.rows.find((r): r is ChainConnectorRow => r.kind === 'connector' && r.key === key)
  if (!row) throw new Error(`no ${key} connector`)
  return row
}

const rowIds = (panel: ReturnType<typeof useSyncChainPanel>) => panel.chain.value.rows.map((row) => row.id)

function card(panel: ReturnType<typeof useSyncChainPanel>, id: string): ChainCardRow {
  const row = panel.chain.value.rows.find((r): r is ChainCardRow => r.kind === 'card' && r.id === id)
  if (!row) throw new Error(`no ${id}`)
  return row
}

function available(panel: ReturnType<typeof useSyncChainPanel>, id: string): ChainAvailableRow {
  const row = panel.chain.value.rows.find((r): r is ChainAvailableRow => r.kind === 'available' && r.id === id)
  if (!row) throw new Error(`no ${id}`)
  return row
}

function absMatch(overrides: Partial<AudiobookshelfBookSyncLink> = {}) {
  absState.link.value = {
    audioBookId: 20,
    absLibraryItemId: 'abs-1',
    title: 'Dune',
    authorName: null,
    libraryName: 'Fiction',
    direction: 'two_way',
    syncing: true,
    pausedReason: null,
    webUrl: null,
    ...overrides,
  }
}

describe('useSyncChainPanel', () => {
  beforeEach(() => {
    calls.length = 0
    editionLinkState = createEditionLinkState()
    alignmentState = createAlignmentState()
    readAlongState = createReadAlongState()
    absState = createAbsState()
    for (const mock of Object.values(toastMocks)) mock.mockReset()
    for (const mock of Object.values(absApiMocks)) mock.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  describe('chain', () => {
    it('puts this ebook first with the proposed audiobook as an auto-matched candidate', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(card(panel, 'card:ebook')).toMatchObject({
        title: 'Dune',
        subtitle: 'Frank Herbert',
        isThisBook: true,
        cover: { kind: 'book', bookId: 10, coverVersion: 'v1' },
      })
      expect(available(panel, 'available:audiobook')).toMatchObject({
        variant: 'candidate',
        cover: { kind: 'book', bookId: 20 },
        note: { key: 'book.detail.editionLink.chain.available.candidateAuto', params: { score: 96, title: 'Dune (audio)' } },
      })
      expect(rowIds(panel)).toEqual(['card:ebook', 'available-header', 'available:readAlong', 'available:audiobook'])
    })

    it('puts this audiobook on the audiobook side, ebook first', () => {
      const panel = mountPanel(makeBook('m4b', 20))

      expect(card(panel, 'card:audiobook').isThisBook).toBe(true)
      expect(available(panel, 'available:ebook')).toMatchObject({ variant: 'search', cover: { kind: 'none' } })
    })

    it('reads a linked pair from the members, starting an unread member at 0%', () => {
      linkPairState()
      const panel = mountPanel()

      expect(card(panel, 'card:ebook')).toMatchObject({ progress: 26, isThisBook: true, cover: { coverVersion: 'v1' } })
      expect(card(panel, 'card:audiobook')).toMatchObject({ progress: 0, isThisBook: false, routeBookId: 20 })
    })

    it('takes the read-along member strictly from the link, never from a ready output', () => {
      linkPairState()
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()

      expect(rowIds(panel)).not.toContain('card:readAlong')
      expect(available(panel, 'available:readAlong').variant).toBe('readAlongDetached')
    })

    it('marks a picked candidate as selected rather than matched', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.search.pick(other)

      expect(available(panel, 'available:audiobook').note).toEqual({
        key: 'book.detail.editionLink.chain.available.candidatePicked',
        params: { title: 'Dune Messiah (audio)' },
      })
    })

    it('knows a read-aloud issue only on the audiobook or read-along page', () => {
      const issue: ReadAloudProgressSync = { ...noIssue, unavailableReason: 'audio_changed' }
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      expect(connector(mountPanel(makeBook('epub', 10, issue)), 'readAlong-audiobook').state).toBe('linked')

      editionLinkState.role.value = 'audio'
      expect(connector(mountPanel(makeBook('m4b', 20, issue)), 'readAlong-audiobook').state).toBe('readAloudIssue')
      expect(connector(mountPanel(makeBook('m4b', 20)), 'readAlong-audiobook').state).toBe('linked')
    })

    it('leaves Audiobookshelf out without its permission, and looks it up for the audiobook side', () => {
      linkPairState()
      absMatch()
      const panel = mountPanel()
      expect(absState.audioBookIds.at(-1)).toBe(20)
      expect(rowIds(panel)).toContain('card:abs')

      permissionMocks.hasPermission.mockImplementation((name) => name !== 'audiobookshelf_sync')
      expect(rowIds(mountPanel())).not.toContain('card:abs')
    })

    it('carries the permissions into the chain', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name === 'library_upload')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(available(panel, 'available:audiobook')).toMatchObject({ locked: true, action: { id: 'linkPair', disabled: true } })
      expect(panel.canRequestReadAlongRebuild.value).toBe(false)
    })
  })

  describe('linking', () => {
    it('links the selected candidate, then builds the alignment on the pair, then reads the new pair', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.runAction('linkPair', 'available:audiobook')
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(calls.slice(0, 3)).toEqual(['link', 'alignment', 'readAlongStatus'])
      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
      expect(readAlongState.build).not.toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('Books linked.')
    })

    it('reads Linking from the link request until the first build is under way', async () => {
      editionLinkState.proposed.value = proposal
      let finishBuild!: () => void
      alignmentState.build.mockImplementation(() => new Promise<void>((resolve) => (finishBuild = resolve)))
      const panel = mountPanel()

      panel.runAction('linkPair')
      await flushPromises()
      expect(connector(panel, 'ebook-audiobook').state).toBe('linking')
      expect(panel.chain.value.header.label.key).toBe('book.detail.editionLink.chain.header.linking')

      finishBuild()
      await flushPromises()
      expect(connector(panel, 'ebook-audiobook').state).toBe('notAligned')
    })

    it('builds nothing and says so when the link fails', async () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.linkBook.mockResolvedValueOnce(false)
      editionLinkState.error.value = 'Failed to link book'
      const panel = mountPanel()

      panel.runAction('linkPair')
      await flushPromises()

      expect(alignmentState.build).not.toHaveBeenCalled()
      expect(toastMocks.error).toHaveBeenCalledWith('Failed to link book')
      expect(rowIds(panel)).not.toContain('connector:ebook-audiobook')
      expect(available(panel, 'available:audiobook').variant).toBe('candidate')
    })

    it("links a detached read-along's own pair through its ebook and aligns that pair", async () => {
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers(member(30, 'Dune (read-along)'))
      const panel = mountPanel(makeBook('epub', 30))
      expect(card(panel, 'card:readAlong')).toMatchObject({
        isThisBook: true,
        title: 'Dune',
        subtitle: 'Frank Herbert',
        cover: { kind: 'book', bookId: 30, coverVersion: 'v1' },
      })
      expect(available(panel, 'available:ebook').note.key).toBe('book.detail.editionLink.chain.available.candidatePair')

      panel.runAction('linkPair', 'available:ebook')
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
    })
  })

  describe('switching the pair off', () => {
    it('cancels a link still aligning and unlinks with no confirm, keeping the counterpart offered', async () => {
      linkPairState()
      alignmentState.status.value = 'building'
      const panel = mountPanel()
      expect(connector(panel, 'ebook-audiobook').state).toBe('linking')

      panel.switchConnector('ebook-audiobook', false)
      await flushPromises()

      expect(panel.dialog.value).toBeNull()
      expect(calls.slice(0, 2)).toEqual(['cancelAlignment', 'unlink'])
      expect(available(panel, 'available:audiobook').note.params).toEqual({ title: 'Dune (audio)' })
      expect(readAlongState.reset).toHaveBeenCalled()
    })

    it('cancels a running read-along first, then the alignment, then unlinks', async () => {
      linkPairState()
      alignmentState.status.value = 'building'
      readAlongState.status.value = 'building'
      const panel = mountPanel()

      panel.runAction('cancelLinking')
      await flushPromises()

      expect(calls.slice(0, 3)).toEqual(['cancelReadAlong', 'cancelAlignment', 'unlink'])
    })

    it('keeps the link when the read-along is already being imported', async () => {
      linkPairState()
      alignmentState.status.value = 'building'
      readAlongState.status.value = 'building'
      readAlongState.cancel.mockResolvedValueOnce('too_late')
      const panel = mountPanel()

      panel.runAction('cancelLinking')
      await flushPromises()

      expect(editionLinkState.unlink).not.toHaveBeenCalled()
      expect(toastMocks.error).toHaveBeenCalledWith("The read-along is being imported and can't be cancelled now.")
    })

    it('asks before unlinking an aligned pair, and a cancelled confirm leaves the switch on', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.switchConnector('ebook-audiobook', false)
      expect(panel.dialog.value?.kind).toBe('unlinkPair')
      expect(panel.dialog.value?.description.key).toBe('book.detail.editionLink.chain.confirm.unlinkPair.description')

      panel.cancelDialog()
      expect(panel.dialog.value).toBeNull()
      expect(connector(panel, 'ebook-audiobook').switch?.on).toBe(true)
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
    })

    it('unlinks on confirm and forgets the pair before reading the statuses again', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.switchConnector('ebook-audiobook', false)
      await panel.confirmDialog()

      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
      expect(calls.slice(0, 4)).toEqual(['unlink', 'readAlongReset', 'alignmentStatus', 'readAlongStatus'])
      expect(toastMocks.success).toHaveBeenCalledWith('Books unlinked.')
      expect(panel.dialog.value).toBeNull()
    })

    it('stops a read-along build in flight before unlinking an established pair', async () => {
      alignedPair()
      readAlongState.status.value = 'queued'
      const panel = mountPanel()

      panel.runAction('unlinkPair')
      await panel.confirmDialog()

      expect(calls.slice(0, 2)).toEqual(['cancelReadAlong', 'unlink'])
    })

    it('names the read-along in the unlink confirm when one is attached', () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      const panel = mountPanel()

      panel.switchConnector('readAlong-audiobook', false)

      expect(panel.dialog.value?.kind).toBe('unlinkPair')
      expect(panel.dialog.value?.description.key).toBe('book.detail.editionLink.chain.confirm.unlinkPair.descriptionReadAlong')
    })
  })

  describe('the read-along', () => {
    it('detaches it behind a confirm and reads its status again without reloading the link', async () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.unlink.mockImplementation(async () => {
        editionLinkState.members.value = makeMembers()
        return true
      })
      const panel = mountPanel()

      panel.switchConnector('ebook-readAlong', false)
      expect(panel.dialog.value?.kind).toBe('detachReadAlong')
      await panel.confirmDialog()
      await flushPromises()

      expect(editionLinkState.unlink).toHaveBeenCalledWith(30)
      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10)
      expect(editionLinkState.loadForBook).not.toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('Read-along no longer syncing.')
      expect(rowIds(panel)).toContain('available:readAlong')
    })

    it('attaches a detached read-along when its switch goes on', async () => {
      alignedPair()
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()
      expect(panel.chain.value.rows.find((row) => row.id === 'available:readAlong')).toMatchObject({ variant: 'readAlongDetached' })

      panel.runAction('attachReadAlong', 'available:readAlong')
      await flushPromises()

      expect(editionLinkState.attachReadAlong).toHaveBeenCalledWith(10, 30)
      expect(toastMocks.success).toHaveBeenCalledWith('Read-along syncing again.')
    })

    it('says so when the attach is refused', async () => {
      alignedPair()
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.attachReadAlong.mockResolvedValueOnce(false)
      const panel = mountPanel()

      panel.runAction('attachReadAlong')
      await flushPromises()

      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't sync the read-along.")
    })

    it('reloads the link once per output that the members lack, hiding the row while it does', async () => {
      alignedPair()
      let finishLoad!: () => void
      editionLinkState.loadForBook.mockImplementation(() => new Promise<void>((resolve) => (finishLoad = resolve)))
      const panel = mountPanel()

      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      await nextTick()
      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
      expect(rowIds(panel)).not.toContain('available:readAlong')

      finishLoad()
      await flushPromises()
      expect(rowIds(panel)).toContain('available:readAlong')

      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      await nextTick()
      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
    })

    it('opens the generate options, loading destinations and importable books, and builds on the second tap', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.runAction('openGenerate', 'available:readAlong')
      expect(panel.expandedRowId.value).toBe('available:readAlong')
      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
      expect(readAlongState.build).not.toHaveBeenCalled()

      panel.runAction('generate', 'available:readAlong')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
      expect(panel.expandedRowId.value).toBeNull()
    })

    it('rebuilds only through its confirm', async () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      const panel = mountPanel()

      panel.runAction('rebuildReadAlong', 'card:readAlong')
      expect(panel.dialog.value?.kind).toBe('rebuildReadAlong')
      expect(panel.dialog.value?.description.params).toEqual({ title: 'Dune (read-along)' })
      expect(readAlongState.build).not.toHaveBeenCalled()

      await panel.confirmDialog()
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, { force: true })
    })

    it('offers an outside rebuild only for a ready member with both permissions', () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      expect(mountPanel().canRequestReadAlongRebuild.value).toBe(true)

      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_delete_books')
      expect(mountPanel().canRequestReadAlongRebuild.value).toBe(false)

      permissionMocks.hasPermission.mockReturnValue(true)
      readAlongState.status.value = 'none'
      expect(mountPanel().canRequestReadAlongRebuild.value).toBe(false)
    })
  })

  describe('cancelling', () => {
    it('locks the cancel buttons only while a cancel is itself in flight', async () => {
      linkPairState()
      alignmentState.status.value = 'building'
      let finishCancel!: (cancelled: boolean) => void
      alignmentState.cancel.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishCancel = resolve)))
      const panel = mountPanel()
      expect(panel.cancelling.value).toBe(false)

      panel.runAction('cancelLinking')
      await nextTick()
      expect(panel.cancelling.value).toBe(true)

      finishCancel(true)
      await flushPromises()
      expect(panel.cancelling.value).toBe(false)
    })

    it('leaves Cancel linking available while the alignment build request is in flight', async () => {
      editionLinkState.proposed.value = proposal
      alignmentState.build.mockImplementationOnce(() => new Promise<void>(() => undefined))
      const panel = mountPanel()

      panel.runAction('linkPair')
      await flushPromises()

      expect(connector(panel, 'ebook-audiobook')).toMatchObject({ state: 'linking', cancel: { id: 'cancelLinking' } })
      expect(panel.cancelling.value).toBe(false)
    })
  })

  describe('alignment actions', () => {
    it('retries and aligns without force, rebuilds with force, and cancels a rebuild only', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.runAction('retryAlignment')
      panel.runAction('alignNow')
      panel.runAction('rebuildAlignment')
      panel.runAction('cancelAlignment')
      await flushPromises()

      expect(alignmentState.build.mock.calls).toEqual([
        [10, false],
        [10, false],
        [10, true],
      ])
      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
    })
  })

  describe('Change', () => {
    it('searches in place of the card and asks before swapping the pick in', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.runAction('change', 'card:audiobook')
      expect(panel.changing.value).toBe('audiobook')
      expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('')
      expect(panel.search.autofocus.value).toBe(true)

      panel.search.pick(other)
      expect(panel.dialog.value?.kind).toBe('change')
      expect(panel.dialog.value?.title.params).toEqual({ title: 'Dune Messiah (audio)' })
      expect(panel.dialog.value?.description.params).toEqual({ kind: 'audiobook' })

      await panel.confirmDialog()
      await flushPromises()

      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
      expect(editionLinkState.linkBook).toHaveBeenCalledWith(21, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(panel.changing.value).toBeNull()
    })

    it('offers the pick as the candidate when its link fails after the unlink', async () => {
      alignedPair()
      editionLinkState.linkBook.mockImplementationOnce(async () => false)
      const panel = mountPanel()

      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      await panel.confirmDialog()
      await flushPromises()

      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't link Dune Messiah (audio). The previous edition was unlinked.")
      expect(available(panel, 'available:audiobook').note.params).toEqual({ title: 'Dune Messiah (audio)' })
      expect(alignmentState.build).not.toHaveBeenCalled()
    })

    it('says a refused alignment cancel kept running and still relinks', async () => {
      alignedPair()
      alignmentState.status.value = 'building'
      alignmentState.cancel.mockResolvedValueOnce(false)
      const panel = mountPanel()

      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      await panel.confirmDialog()
      await flushPromises()

      expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining('running'))
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
      expect(editionLinkState.linkBook).toHaveBeenCalledWith(21, 10)
    })

    it('only picks before a link, closing the search', () => {
      const panel = mountPanel()

      panel.runAction('openSearch', 'available:audiobook')
      expect(panel.expandedRowId.value).toBe('available:audiobook')
      panel.search.pick(other)

      expect(panel.dialog.value).toBeNull()
      expect(available(panel, 'available:audiobook').note.params).toEqual({ title: 'Dune Messiah (audio)' })
      expect(panel.expandedRowId.value).toBeNull()
    })
  })

  describe('Audiobookshelf', () => {
    it('resumes a paused match from its row', async () => {
      alignedPair()
      absMatch({ syncing: false, pausedReason: 'excluded' })
      absApiMocks.exclusion.mockResolvedValueOnce({} as AudiobookshelfBookState)
      const panel = mountPanel()

      panel.runAction('resumeAbs', 'available:abs')
      await flushPromises()

      expect(absApiMocks.exclusion).toHaveBeenCalledWith('abs-1', false)
      expect(absState.reload).toHaveBeenCalled()
    })

    it('pauses a syncing match behind a confirm, keeping the match', async () => {
      alignedPair()
      absMatch()
      absApiMocks.exclusion.mockResolvedValueOnce({} as AudiobookshelfBookState)
      const panel = mountPanel()

      panel.switchConnector('audiobook-abs', false)
      expect(panel.dialog.value?.kind).toBe('pauseAbs')
      await panel.confirmDialog()

      expect(absApiMocks.exclusion).toHaveBeenCalledWith('abs-1', true)
      expect(absApiMocks.unlink).not.toHaveBeenCalled()
    })

    it('confirms a match under review', async () => {
      alignedPair()
      absMatch({ syncing: false, pausedReason: 'needs_review' })
      absApiMocks.confirm.mockResolvedValueOnce({} as AudiobookshelfBookState)
      const panel = mountPanel()

      panel.runAction('confirmAbs', 'available:abs')
      await flushPromises()

      expect(absApiMocks.confirm).toHaveBeenCalledWith('abs-1')
    })

    it('retries the live check', () => {
      alignedPair()
      absMatch()
      const panel = mountPanel()

      panel.runAction('retryAbs')

      expect(absState.refreshLive).toHaveBeenCalledTimes(1)
    })

    it('forgets the failure of an earlier visit when it is opened again', async () => {
      alignedPair()
      absMatch()
      absApiMocks.reconcile.mockRejectedValueOnce(new AudiobookshelfReconcileError('nope', 502))
      const panel = mountPanel()
      panel.runAction('absPush')
      await flushPromises()
      expect(panel.absActions.actionError.value).toBe('Could not reach Audiobookshelf.')

      await panel.handleOpen()

      expect(panel.absActions.actionError.value).toBeNull()
    })
  })

  describe('opening', () => {
    it('starts over without searching, then refreshes the statuses and Audiobookshelf', async () => {
      alignedPair()
      const panel = mountPanel()
      panel.runAction('change', 'card:audiobook')
      panel.runAction('toggleLog')
      editionLinkState.searchCandidates.mockClear()

      await panel.handleOpen()

      expect(panel.changing.value).toBeNull()
      expect(panel.logOpen.value).toBe(false)
      expect(panel.expandedRowId.value).toBeNull()
      expect(editionLinkState.resetSearch).toHaveBeenCalled()
      expect(editionLinkState.searchCandidates).not.toHaveBeenCalled()
      expect(readAlongState.resetKeepRemoteCopy).toHaveBeenCalled()
      expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10)
      expect(absState.refreshLive).toHaveBeenCalled()
    })

    it('asks an unlinked book for the read-along of the pair it would make', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      await panel.handleOpen()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, 20)
    })
  })

  describe('view mode', () => {
    it('decides after the open has loaded: Modify when it fits, compact when it does not', async () => {
      alignedPair()
      const roomy = mountPanel()
      roomy.prepareView(10_000)
      await roomy.handleOpen()
      expect(roomy.viewMode.value).toBe('modify')

      const cramped = mountPanel()
      cramped.prepareView(100)
      await cramped.handleOpen()
      expect(cramped.viewMode.value).toBe('compact')
    })

    it('opens in Modify when something needs attention, whatever the space', async () => {
      linkPairState()
      alignmentState.status.value = 'failed'
      const panel = mountPanel()
      panel.prepareView(100)

      await panel.handleOpen()

      expect(panel.viewMode.value).toBe('modify')
    })

    it('takes a forced view, and waits for the load before deciding', async () => {
      alignedPair()
      let finishLoad!: () => void
      editionLinkState.loadForBook.mockImplementation(() => new Promise<void>((resolve) => (finishLoad = resolve)))
      const panel = mountPanel()

      panel.prepareView(100, 'modify')
      const opening = panel.handleOpen()
      expect(panel.viewMode.value).toBeNull()

      finishLoad()
      await opening
      expect(panel.viewMode.value).toBe('modify')
    })

    it('decides from the refreshed statuses, not from the chain cached by an earlier visit', async () => {
      alignedPair()
      const panel = mountPanel()
      panel.prepareView(100)
      await panel.handleOpen()
      expect(panel.viewMode.value).toBe('compact')

      alignmentState.fetchStatus.mockImplementationOnce(async () => {
        alignmentState.status.value = 'failed'
      })
      panel.prepareView(100)
      await panel.handleOpen()

      expect(panel.viewMode.value).toBe('modify')
    })

    it('waits for the status refetches but not for the live Audiobookshelf check', async () => {
      alignedPair()
      let finishStatus!: () => void
      alignmentState.fetchStatus.mockImplementationOnce(() => new Promise<void>((resolve) => (finishStatus = resolve)))
      absState.refreshLive.mockReturnValue(new Promise<void>(() => undefined))
      const panel = mountPanel()
      panel.prepareView(10_000)

      const opening = panel.handleOpen()
      await flushPromises()
      expect(panel.viewMode.value).toBeNull()

      finishStatus()
      await opening
      expect(panel.viewMode.value).toBe('modify')
    })

    it('stays compact while nothing needs attention', async () => {
      alignedPair()
      const panel = mountPanel()
      panel.prepareView(100)
      await panel.handleOpen()

      await nextTick()

      expect(panel.viewMode.value).toBe('compact')
    })

    it('promotes a compact view to Modify once when something needs attention later in the same open, and never demotes', async () => {
      alignedPair()
      const panel = mountPanel()
      panel.prepareView(100)
      await panel.handleOpen()
      expect(panel.viewMode.value).toBe('compact')

      alignmentState.status.value = 'failed'
      await nextTick()
      expect(panel.viewMode.value).toBe('modify')

      alignmentState.status.value = 'ready'
      await nextTick()
      expect(panel.viewMode.value).toBe('modify')

      panel.setViewMode('compact')
      alignmentState.status.value = 'failed'
      await nextTick()
      expect(panel.viewMode.value).toBe('compact')
    })

    it('keeps the view compact when the reader tapped Done out of Modify before something needs attention', async () => {
      alignedPair()
      const panel = mountPanel()
      panel.prepareView(100, 'modify')
      await panel.handleOpen()
      expect(panel.viewMode.value).toBe('modify')

      panel.setViewMode('compact')
      alignmentState.status.value = 'failed'
      await nextTick()

      expect(panel.viewMode.value).toBe('compact')
    })
  })

  describe('trigger', () => {
    it.each([
      ['none', 'none', 'text-primary', 'Manage the linked edition.'],
      ['building', 'none', 'text-info', 'Linked - building position sync...'],
      ['ready', 'none', 'text-success', 'Linked - position sync ready.'],
      ['failed', 'none', 'text-destructive', 'Linked - position sync failed. Rebuild it from this panel.'],
      ['ready', 'queued', 'text-info', 'Linked - read-along queued.'],
      ['ready', 'failed', 'text-destructive', 'Linked - read-along build failed.'],
    ] as const)('narrates alignment %s and read-along %s', (alignment, readAlong, tint, tooltip) => {
      linkPairState()
      alignmentState.status.value = alignment
      readAlongState.status.value = readAlong
      const panel = mountPanel()

      expect(panel.triggerIconClass.value).toBe(tint)
      expect(panel.triggerTooltip.value).toBe(tooltip)
    })

    it('warns when the position sync is ready but out of date', () => {
      linkPairState()
      alignmentState.status.value = 'ready'
      alignmentState.stale.value = true
      const panel = mountPanel()

      expect(panel.triggerIconClass.value).toBe('text-warning')
      expect(panel.triggerTooltip.value).toBe('Linked - position sync out of date. Rebuild it from this panel.')
    })

    it('leaves the icon neutral and names position sync before a link exists', () => {
      expect(mountPanel().triggerIconClass.value).toBe('')
      expect(mountPanel().triggerTooltip.value).toBe('Link an audiobook to enable position sync.')
      expect(mountPanel(makeBook('m4b', 20)).triggerTooltip.value).toBe('Link an ebook to enable position sync.')
    })
  })
})
