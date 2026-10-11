import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import type { AudiobookshelfBookState, AudiobookshelfBookSyncLink, BookDetail, EditionLinkMember, ReadAloudProgressSync } from '@bookorbit/types'
import type { ChainCardRow, ChainConnectorRow, ChainGhostRow, ChainReadAlongSlotRow, ConnectorKey } from '@/features/book/lib/sync-chain'
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
  editionLinkState.pageRole = book.id === 30 ? 'readAlong' : book.files[0]?.format === 'm4b' ? 'audio' : 'text'
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

function ghost(panel: ReturnType<typeof useSyncChainPanel>, id: string): ChainGhostRow {
  const row = panel.chain.value.rows.find((r): r is ChainGhostRow => r.kind === 'ghost' && r.id === id)
  if (!row) throw new Error(`no ${id}`)
  return row
}

function slot(panel: ReturnType<typeof useSyncChainPanel>): ChainReadAlongSlotRow {
  const row = panel.chain.value.rows.find((r): r is ChainReadAlongSlotRow => r.kind === 'readAlongSlot')
  if (!row) throw new Error('no read-along slot')
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
      expect(card(panel, 'card:audiobook')).toMatchObject({
        linked: false,
        cover: { kind: 'book', bookId: 20 },
        chip: { key: 'book.detail.editionLink.chain.chip.match', params: { score: 96 } },
      })
      expect(rowIds(panel)).toEqual([
        'card:ebook',
        'connector:ebook-audiobook',
        'card:audiobook',
        'connector:audiobook-abs',
        'card:abs',
        'connector:readAlong-audiobook',
        'slot:readAlong',
      ])
      expect(connector(panel, 'ebook-audiobook').switch).toMatchObject({ on: false, disabled: false, onAction: 'linkPair' })
      expect(slot(panel).variant).toBe('notGenerated')
    })

    it('puts this audiobook on the audiobook side, ebook first', () => {
      const panel = mountPanel(makeBook('m4b', 20))

      expect(card(panel, 'card:audiobook').isThisBook).toBe(true)
      expect(ghost(panel, 'card:ebook').note.key).toBe('book.detail.editionLink.chain.ghost.noMatchEbook')
      expect(slot(panel).variant).toBe('needsEbook')
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

      expect(card(panel, 'card:readAlong')).toMatchObject({ linked: false, chip: { key: 'book.detail.editionLink.chain.chip.generated' } })
      expect(connector(panel, 'readAlong-audiobook').state).toBe('available')
    })

    it('marks a picked candidate as selected rather than matched', () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.search.pick(other)

      expect(card(panel, 'card:audiobook')).toMatchObject({
        title: 'Dune Messiah (audio)',
        chip: { key: 'book.detail.editionLink.chain.chip.selected' },
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

    it('leaves both Audiobookshelf rows out while the integration is not configured for this reader', () => {
      linkPairState()
      absState.configured.value = false
      const panel = mountPanel()
      expect(rowIds(panel)).not.toContain('connector:audiobook-abs')
      expect(rowIds(panel)).not.toContain('card:abs')

      absState.configured.value = true
      expect(rowIds(panel)).toContain('connector:audiobook-abs')
    })

    it('carries the permissions into the chain', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name === 'library_upload')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').change).toBe('none')
      expect(connector(panel, 'ebook-audiobook')).toMatchObject({
        switch: { disabled: true },
        disabledReason: { key: 'book.detail.editionLink.chain.disabled.noPermission' },
      })
    })
  })

  describe('linking', () => {
    it('links the selected candidate, then builds the alignment on the pair, then reads the new pair', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.switchConnector('ebook-audiobook', true)
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(calls.slice(0, 3)).toEqual(['link', 'alignment', 'readAlongStatus'])
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, null)
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
      expect(connector(panel, 'ebook-audiobook')).toMatchObject({ state: 'available', switch: { on: false } })
      expect(card(panel, 'card:audiobook').linked).toBe(false)
    })

    it("links a detached read-along's own pair through its ebook and aligns that pair", async () => {
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel(makeBook('epub', 30))
      expect(card(panel, 'card:readAlong')).toMatchObject({
        isThisBook: true,
        title: 'Dune',
        subtitle: 'Frank Herbert',
        cover: { kind: 'book', bookId: 30, coverVersion: 'v1' },
      })
      expect(card(panel, 'card:ebook').chip?.key).toBe('book.detail.editionLink.chain.chip.generatedFrom')

      panel.switchConnector('ebook-audiobook', true)
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
      expect(card(panel, 'card:audiobook')).toMatchObject({ linked: false, title: 'Dune (audio)' })
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

    it('says the read-along stays with the audiobook when the ebook leaves', () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      const panel = mountPanel()

      panel.switchConnector('ebook-audiobook', false)

      expect(panel.dialog.value?.kind).toBe('unlinkPair')
      expect(panel.dialog.value?.description.key).toBe('book.detail.editionLink.chain.confirm.unlinkPair.descriptionReadAlongStays')
    })

    it('says the read-along stops syncing when the audiobook leaves', () => {
      alignedPair(member(30, 'Dune (read-along)'))
      editionLinkState.role.value = 'audio'
      readAlongState.status.value = 'ready'
      const panel = mountPanel(makeBook('m4b', 20))

      panel.switchConnector('ebook-audiobook', false)

      expect(panel.dialog.value?.description.key).toBe('book.detail.editionLink.chain.confirm.unlinkPair.descriptionReadAlong')
    })

    it('shows the read-along attached to the candidate audiobook from an unlinked ebook page', () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()

      expect(panel.chain.value.header).toEqual({
        tone: 'success',
        label: { key: 'book.detail.editionLink.chain.header.inSync', params: { n: 2, m: 3 } },
      })
      expect(connector(panel, 'ebook-audiobook')).toMatchObject({ switch: { on: false, disabled: false, onAction: 'linkPair' } })
      expect(connector(panel, 'readAlong-audiobook')).toMatchObject({ state: 'linked', switch: { on: true } })

      panel.switchConnector('readAlong-audiobook', false)

      expect(panel.dialog.value?.kind).toBe('detachReadAlong')
    })

    it('offers the proposed ebook on a link that has none and links it to the audiobook', async () => {
      editionLinkState.link.value = { ...linkRecord, textBookId: null, readAlongBookId: 30 }
      editionLinkState.role.value = 'audio'
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      editionLinkState.linkedCounterpart.value = { id: 30, title: 'Dune (read-along)', authorName: 'Frank Herbert', coverVersion: null }
      editionLinkState.proposed.value = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 }
      readAlongState.status.value = 'ready'
      const panel = mountPanel(makeBook('m4b', 20))

      expect(panel.chain.value.header).toEqual({
        tone: 'success',
        label: { key: 'book.detail.editionLink.chain.header.inSync', params: { n: 2, m: 3 } },
      })
      expect(panel.chain.value.rows.find((row) => row.id === 'card:ebook')).toMatchObject({
        kind: 'card',
        edition: 'ebook',
        linked: false,
        title: 'Dune',
        chip: { key: 'book.detail.editionLink.chain.chip.match' },
      })
      expect(connector(panel, 'ebook-audiobook')).toMatchObject({ switch: { on: false, disabled: false, onAction: 'linkPair' } })

      panel.switchConnector('ebook-audiobook', true)
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(10, 20)
    })

    it('fills the ebook of a link that has none from Change, without unlinking the audiobook', async () => {
      editionLinkState.link.value = { ...linkRecord, textBookId: null, readAlongBookId: 30 }
      editionLinkState.role.value = 'audio'
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      editionLinkState.proposed.value = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 }
      readAlongState.status.value = 'ready'
      const panel = mountPanel(makeBook('m4b', 20))
      const pickedEbook: EditionLinkCandidate = {
        bookId: 11,
        title: 'Dune (illustrated)',
        authorName: 'Frank Herbert',
        coverVersion: null,
        score: 50,
      }

      panel.runAction('change', 'card:ebook')
      panel.search.pick(pickedEbook)

      expect(panel.dialog.value).toBeNull()
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
      expect(card(panel, 'card:ebook')).toMatchObject({ linked: false, title: 'Dune (illustrated)' })

      panel.switchConnector('ebook-audiobook', true)
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledExactlyOnceWith(11, 20)
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
    })

    it('cancels a link still aligning from the audiobook page through the ebook, so the read-along stays', async () => {
      linkPairState(member(30, 'Dune (read-along)'))
      editionLinkState.role.value = 'audio'
      alignmentState.status.value = 'building'
      const panel = mountPanel(makeBook('m4b', 20))
      expect(connector(panel, 'ebook-audiobook').state).toBe('linking')

      panel.switchConnector('ebook-audiobook', false)
      await flushPromises()

      expect(panel.dialog.value).toBeNull()
      expect(editionLinkState.unlink).toHaveBeenCalledExactlyOnceWith(10)
    })

    it('offers the ebook again after cancelling a link still aligning from the read-along page', async () => {
      const readAlong = member(30, 'Dune (read-along)')
      linkPairState(readAlong)
      editionLinkState.role.value = 'readAlong'
      alignmentState.status.value = 'building'
      editionLinkState.unlink.mockImplementation(async () => {
        editionLinkState.link.value = { ...linkRecord, textBookId: null, readAlongBookId: 30 }
        editionLinkState.members.value = { ...makeMembers(readAlong), text: null }
        return true
      })
      const panel = mountPanel(makeBook('epub', 30))

      panel.switchConnector('ebook-audiobook', false)
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalledExactlyOnceWith(10)
      expect(card(panel, 'card:ebook')).toMatchObject({ linked: false, title: 'Dune' })

      panel.switchConnector('ebook-audiobook', true)
      await flushPromises()
      expect(editionLinkState.linkBook).toHaveBeenCalledExactlyOnceWith(10, 20)
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

      panel.switchConnector('readAlong-audiobook', false)
      expect(panel.dialog.value?.kind).toBe('detachReadAlong')
      await panel.confirmDialog()
      await flushPromises()

      expect(editionLinkState.unlink).toHaveBeenCalledWith(30)
      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, null)
      expect(editionLinkState.loadForBook).not.toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('Read-along no longer syncing.')
      expect(card(panel, 'card:readAlong')).toMatchObject({ linked: false, chip: { key: 'book.detail.editionLink.chain.chip.generated' } })
    })

    it('attaches a detached read-along when its switch goes on', async () => {
      alignedPair()
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()
      expect(connector(panel, 'readAlong-audiobook').switch).toMatchObject({ on: false, disabled: false, onAction: 'attachReadAlong' })

      panel.switchConnector('readAlong-audiobook', true)
      await flushPromises()

      expect(editionLinkState.attachReadAlong).toHaveBeenCalledWith(10, 30)
      expect(toastMocks.success).toHaveBeenCalledWith('Read-along syncing again.')
    })

    it('attaches to the audiobook while the ebook and audiobook are not linked', async () => {
      editionLinkState.proposed.value = proposal
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()
      expect(connector(panel, 'readAlong-audiobook')).toMatchObject({ switch: { on: false, disabled: false }, disabledReason: null })

      panel.switchConnector('readAlong-audiobook', true)
      await flushPromises()

      expect(editionLinkState.attachReadAlong).toHaveBeenCalledWith(20, 30)
    })

    it('detaches from the read-along switch even on the read-along page', () => {
      editionLinkState.role.value = 'readAlong'
      linkPairState(member(30, 'Dune (read-along)'))
      editionLinkState.role.value = 'readAlong'
      readAlongState.status.value = 'ready'
      const panel = mountPanel(makeBook('epub', 30))

      panel.switchConnector('readAlong-audiobook', false)

      expect(panel.dialog.value?.kind).toBe('detachReadAlong')
    })

    it('attaches a detached read-along from its own page when its pair is not linked', async () => {
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers()
      const panel = mountPanel(makeBook('epub', 30))
      expect(connector(panel, 'readAlong-audiobook').switch).toMatchObject({ on: false, disabled: false, onAction: 'attachReadAlong' })

      panel.switchConnector('readAlong-audiobook', true)
      await flushPromises()

      expect(editionLinkState.attachReadAlong).toHaveBeenCalledWith(20, 30)
      expect(toastMocks.success).toHaveBeenCalledWith('Read-along syncing again.')
    })

    it('reads the status for the counterpart again after a detach on an unlinked ebook page', async () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.unlink.mockImplementation(async () => {
        editionLinkState.members.value = null
        return true
      })
      const panel = mountPanel()

      panel.switchConnector('readAlong-audiobook', false)
      await panel.confirmDialog()
      await flushPromises()

      expect(editionLinkState.unlink).toHaveBeenCalledWith(30)
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 20)
    })

    it('leaves the read-along of another audiobook off the chain once a different one is picked', async () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      const panel = mountPanel()
      expect(rowIds(panel)).toContain('card:readAlong')

      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      await flushPromises()
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 21)
      readAlongState.status.value = 'none'
      readAlongState.outputBook.value = null
      await nextTick()

      expect(rowIds(panel)).not.toContain('card:readAlong')
      expect(slot(panel).id).toBe('slot:readAlong')
      expect(panel.chain.value.header.label.key).toBe('book.detail.editionLink.chain.header.notLinked')
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
      expect(rowIds(panel)).not.toContain('card:readAlong')
      expect(rowIds(panel)).not.toContain('slot:readAlong')

      finishLoad()
      await flushPromises()
      expect(rowIds(panel)).toContain('card:readAlong')

      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      await nextTick()
      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
    })

    it('still heals a missing member after a detach that failed', async () => {
      alignedPair(member(30, 'Dune (read-along)'))
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.unlink.mockResolvedValueOnce(false)
      const panel = mountPanel()
      panel.switchConnector('readAlong-audiobook', false)
      await panel.confirmDialog()
      await flushPromises()
      expect(toastMocks.error).toHaveBeenCalled()
      editionLinkState.loadForBook.mockClear()

      editionLinkState.members.value = makeMembers()
      await flushPromises()

      expect(editionLinkState.loadForBook).toHaveBeenCalledOnce()
    })

    it('ignores the switch-less connector above the un-generated slot in both directions', async () => {
      alignedPair()
      const panel = mountPanel()
      expect(connector(panel, 'readAlong-audiobook').switch).toBeNull()

      panel.switchConnector('readAlong-audiobook', true)
      panel.switchConnector('readAlong-audiobook', false)
      await flushPromises()

      expect(panel.dialog.value).toBeNull()
      expect(panel.optionsOpen.value).toBe(false)
      expect(editionLinkState.attachReadAlong).not.toHaveBeenCalled()
      expect(readAlongState.build).not.toHaveBeenCalled()
    })

    it('opens the generate options, loading destinations and importable books, and builds on the second tap', async () => {
      alignedPair()
      const panel = mountPanel()

      panel.runAction('openGenerate', 'slot:readAlong')
      expect(panel.optionsOpen.value).toBe(true)
      expect(readAlongState.fetchExisting).toHaveBeenCalledWith(10)
      expect(readAlongState.build).not.toHaveBeenCalled()

      panel.runAction('generate', 'slot:readAlong')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
      expect(panel.optionsOpen.value).toBe(false)
    })

    it('builds an unlinked pair with the other edition as the counterpart', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      expect(slot(panel)).toMatchObject({ variant: 'notGenerated', action: { id: 'openGenerate', disabled: false } })

      panel.runAction('openGenerate', 'slot:readAlong')
      panel.runAction('generate', 'slot:readAlong')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, { counterpartId: 20 })

      panel.search.pick(other)
      panel.runAction('retryReadAlong', 'slot:readAlong')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenLastCalledWith(10, { counterpartId: 21 })
    })

    it('keeps a running build of an unlinked pair on screen when the panel is opened again', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      panel.runAction('generate', 'slot:readAlong')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, { counterpartId: 21 })
      readAlongState.status.value = 'building'

      await panel.handleOpen()

      expect(card(panel, 'card:audiobook').title).toBe('Dune Messiah (audio)')
      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(10, 21)
    })

    it.each(['queued', 'building'] as const)('asks for no other pair while a build is %s', async (status) => {
      editionLinkState.proposed.value = proposal
      readAlongState.status.value = status
      mountPanel()
      readAlongState.fetchStatus.mockClear()

      editionLinkState.proposed.value = other
      await flushPromises()

      expect(readAlongState.fetchStatus).not.toHaveBeenCalled()
    })

    it('keeps the pick on a new open while the finished build is attached to no link', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }

      await panel.handleOpen()

      expect(card(panel, 'card:audiobook').title).toBe('Dune Messiah (audio)')
    })

    it('starts over on a new open once the finished build is attached to the pair', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.members.value = { text: null, audio: member(21, 'Dune Messiah (audio)'), readAlong: member(30, 'Dune (read-along)') }

      await panel.handleOpen()

      expect(card(panel, 'card:audiobook').title).toBe('Dune (audio)')
    })

    it('starts over on a new open once the build is gone', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      readAlongState.status.value = 'none'

      await panel.handleOpen()

      expect(card(panel, 'card:audiobook').title).toBe('Dune (audio)')
    })

    it('looks up importable books again when another ebook is picked with the options open', async () => {
      editionLinkState.proposed.value = { ...proposal, bookId: 10, title: 'Dune' }
      const panel = mountPanel(makeBook('m4b', 20))
      panel.runAction('openGenerate', 'slot:readAlong')
      expect(readAlongState.fetchExisting).toHaveBeenCalledExactlyOnceWith(20)

      panel.search.pick({ ...other, bookId: 11, title: 'Dune (illustrated)' })
      await flushPromises()

      expect(readAlongState.fetchStatus).toHaveBeenLastCalledWith(20, 11)
      expect(readAlongState.fetchExisting).toHaveBeenCalledTimes(2)
      const [statusOrder] = readAlongState.fetchStatus.mock.invocationCallOrder.slice(-1)
      const [existingOrder] = readAlongState.fetchExisting.mock.invocationCallOrder.slice(-1)
      expect(existingOrder).toBeGreaterThan(statusOrder!)
    })

    it('does not send a counterpart once the pair is linked', async () => {
      alignedPair()
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      panel.runAction('generate', 'slot:readAlong')
      await flushPromises()

      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
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
      expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('', 10)
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
      expect(card(panel, 'card:audiobook')).toMatchObject({ linked: false, title: 'Dune Messiah (audio)' })
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

    it('searches a read-along page through the pair member the pick will join, not the read-along', () => {
      editionLinkState.link.value = { ...linkRecord, textBookId: null, readAlongBookId: 30 }
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }
      editionLinkState.proposed.value = { bookId: 10, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 }
      const panel = mountPanel(makeBook('epub', 30))

      panel.runAction('change', 'card:ebook')
      panel.search.setQuery('x')

      expect(editionLinkState.searchCandidates).toHaveBeenLastCalledWith('x', 20)
      expect(editionLinkState.searchCandidates).not.toHaveBeenCalledWith(expect.anything(), 30)
    })

    it('searches audiobooks from the ebook page through the ebook itself', () => {
      const panel = mountPanel()

      panel.runAction('change', 'card:audiobook')
      panel.search.setQuery('x')

      expect(editionLinkState.searchCandidates).toHaveBeenLastCalledWith('x', 10)
    })

    it('only picks before a link, closing the search', () => {
      const panel = mountPanel()

      expect(ghost(panel, 'card:audiobook').action).toMatchObject({ id: 'change' })
      panel.runAction('change', 'card:audiobook')
      expect(panel.changing.value).toBe('audiobook')
      panel.search.pick(other)

      expect(panel.dialog.value).toBeNull()
      expect(card(panel, 'card:audiobook')).toMatchObject({ linked: false, title: 'Dune Messiah (audio)' })
      expect(panel.changing.value).toBeNull()
    })
  })

  describe('Audiobookshelf', () => {
    it('resumes a paused match from its switch', async () => {
      alignedPair()
      absMatch({ syncing: false, pausedReason: 'excluded' })
      absApiMocks.exclusion.mockResolvedValueOnce({} as AudiobookshelfBookState)
      const panel = mountPanel()
      expect(card(panel, 'card:abs')).toMatchObject({ linked: false, chip: { key: 'book.detail.editionLink.chain.chip.paused' } })

      panel.switchConnector('audiobook-abs', true)
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

    it('confirms a match under review from its switch or its Confirm', async () => {
      alignedPair()
      absMatch({ syncing: false, pausedReason: 'needs_review' })
      absApiMocks.confirm.mockResolvedValue({} as AudiobookshelfBookState)
      const panel = mountPanel()

      panel.switchConnector('audiobook-abs', true)
      await flushPromises()
      expect(absApiMocks.confirm).toHaveBeenCalledWith('abs-1')

      absApiMocks.confirm.mockClear()
      panel.runAction('confirmAbs', 'card:abs')
      await flushPromises()
      expect(absApiMocks.confirm).toHaveBeenCalledWith('abs-1')
    })

    it('opens the Audiobookshelf search from the Match of an unmatched book', () => {
      alignedPair()
      const panel = mountPanel()
      expect(ghost(panel, 'card:abs').action).toMatchObject({ id: 'change', label: { key: 'book.detail.editionLink.chain.action.match' } })

      panel.runAction('change', 'card:abs')

      expect(panel.changing.value).toBe('abs')
    })

    it('retries the live check', () => {
      alignedPair()
      absMatch()
      const panel = mountPanel()

      panel.runAction('retryAbs')

      expect(absState.refreshLive).toHaveBeenCalledTimes(1)
    })

    it('reloads the link data after a reconcile lands, so every card moves to the new position', async () => {
      alignedPair()
      absMatch()
      absApiMocks.reconcile.mockResolvedValueOnce({
        status: 'synced',
        progress: { percentage: 100, isFinished: true, lastUpdate: 2 },
        local: null,
        divergedReason: null,
      })
      const panel = mountPanel()
      expect(card(panel, 'card:audiobook').progress).toBe(0)
      editionLinkState.loadForBook.mockImplementation(async () => {
        editionLinkState.members.value = { ...makeMembers(), audio: member(20, 'Dune (audio)', 100) }
      })

      panel.runAction('absPull')
      await flushPromises()

      expect(absApiMocks.reconcile).toHaveBeenCalledWith('abs-1', 'pull')
      expect(editionLinkState.loadForBook).toHaveBeenCalledOnce()
      expect(card(panel, 'card:audiobook').progress).toBe(100)
    })

    it("moves this audiobook's bar after Use ABS on an unlinked audiobook page, from a fresh load", async () => {
      editionLinkState.proposed.value = { ...proposal, bookId: 10, title: 'Dune' }
      editionLinkState.thisBookProgress.value = 12
      absMatch()
      absApiMocks.reconcile.mockResolvedValueOnce({
        status: 'synced',
        progress: { percentage: 64, isFinished: false, lastUpdate: 2 },
        local: null,
        divergedReason: null,
      })
      const panel = mountPanel(makeBook('m4b', 20))
      expect(card(panel, 'card:audiobook').progress).toBe(12)
      editionLinkState.invalidateLoad.mockImplementation(() => calls.push('invalidateLoad'))
      editionLinkState.loadForBook.mockImplementation(async () => {
        calls.push('load')
        editionLinkState.thisBookProgress.value = 64
      })
      calls.length = 0

      panel.runAction('absPull')
      await flushPromises()

      expect(calls).toEqual(['invalidateLoad', 'load'])
      expect(card(panel, 'card:audiobook').progress).toBe(64)
    })

    it("shows a candidate audiobook's own position", () => {
      editionLinkState.proposed.value = { ...proposal, progress: 42 }
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').progress).toBe(42)
    })

    it('leaves the link data alone when the reconcile fails', async () => {
      alignedPair()
      absMatch()
      absApiMocks.reconcile.mockRejectedValueOnce(new AudiobookshelfReconcileError('nope', 500))
      const panel = mountPanel()
      const loadsBefore = editionLinkState.loadForBook.mock.calls.length

      panel.runAction('absPush')
      await flushPromises()

      expect(editionLinkState.loadForBook.mock.calls.length).toBe(loadsBefore)
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
      expect(panel.optionsOpen.value).toBe(false)
      expect(editionLinkState.resetSearch).toHaveBeenCalled()
      expect(editionLinkState.searchCandidates).not.toHaveBeenCalled()
      expect(readAlongState.resetKeepRemoteCopy).toHaveBeenCalled()
      expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, null)
      expect(absState.refreshLive).toHaveBeenCalled()
      expect(absState.loadConfigured).toHaveBeenCalledOnce()
    })

    it('asks an unlinked book for the read-along of the pair it would make', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      await panel.handleOpen()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, 20)
    })
  })

  describe('the candidate on screen', () => {
    it("reads the candidate audiobook's position from the members the answer carries", () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.members.value = { text: null, audio: member(20, 'Dune (audio)', 55), readAlong: null }
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').progress).toBe(55)
    })

    it("prefers the member's position to the proposal's", () => {
      editionLinkState.proposed.value = { ...proposal, progress: 10 }
      editionLinkState.members.value = { text: null, audio: member(20, 'Dune (audio)', 55), readAlong: null }
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').progress).toBe(55)
    })

    it('reads a picked audiobook position from the answer that was asked for it', () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.pickedProgress.value = 33
      const panel = mountPanel()
      panel.search.pick(other)

      expect(card(panel, 'card:audiobook').progress).toBe(33)
    })

    it("does not lend the picked audiobook's position to the proposal", () => {
      editionLinkState.proposed.value = proposal
      editionLinkState.pickedProgress.value = 33
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').progress).toBeNull()
    })

    it('keeps the position of a candidate restored after cancelling a link', async () => {
      linkPairState()
      editionLinkState.members.value = { ...makeMembers(), audio: member(20, 'Dune (audio)', 70) }
      alignmentState.status.value = 'building'
      const panel = mountPanel()
      editionLinkState.unlink.mockImplementationOnce(async () => {
        editionLinkState.link.value = null
        editionLinkState.proposed.value = null
        editionLinkState.members.value = null
        return true
      })

      panel.switchConnector('ebook-audiobook', false)
      await flushPromises()

      expect(card(panel, 'card:audiobook').progress).toBe(70)
    })

    it('marks a proposal made from a finished build as such, not as a score match', () => {
      editionLinkState.proposed.value = { ...proposal, fromBuild: true } as EditionLinkCandidate
      const panel = mountPanel()

      expect(card(panel, 'card:audiobook').chip?.key).not.toBe('book.detail.editionLink.chain.chip.match')
    })
  })

  describe('reading the pair on open', () => {
    it('reads the link once when the proposal arrives with the first answer', async () => {
      editionLinkState.loadForBook.mockImplementation(async () => {
        editionLinkState.proposed.value = proposal
      })
      const panel = mountPanel()

      await panel.handleOpen()
      await flushPromises()

      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
    })

    it('reads the link again when the pick differs from the answer', async () => {
      editionLinkState.loadForBook.mockImplementation(async () => {
        editionLinkState.proposed.value = proposal
      })
      const panel = mountPanel()
      await panel.handleOpen()

      panel.search.pick(other)
      await flushPromises()

      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(2)
      expect(editionLinkState.loadForBook).toHaveBeenLastCalledWith(21)
    })

    it('reads the build status without the generate permission once a pair is on screen', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      await panel.handleOpen()

      expect(readAlongState.fetchStatus).toHaveBeenCalledWith(10, 20)
    })

    it('reads nothing for a reader without the generate permission when no pair is on screen', async () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      const panel = mountPanel()

      await panel.handleOpen()

      expect(readAlongState.fetchStatus).not.toHaveBeenCalled()
    })
  })

  describe('following the audiobook on screen', () => {
    it('reloads the link data for a picked audiobook while this ebook is unlinked', async () => {
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()
      await panel.handleOpen()
      expect(editionLinkState.loadForBook).toHaveBeenLastCalledWith(20)

      panel.runAction('change', 'card:audiobook')
      panel.search.pick(other)
      await flushPromises()

      expect(editionLinkState.loadForBook).toHaveBeenLastCalledWith(21)
    })

    it('names no audiobook for a linked page', async () => {
      alignedPair()
      editionLinkState.proposed.value = proposal
      const panel = mountPanel()

      await panel.handleOpen()

      expect(editionLinkState.loadForBook).toHaveBeenCalled()
      for (const args of editionLinkState.loadForBook.mock.calls) expect(args).toEqual([null])
    })

    it('names no audiobook for an unlinked audiobook page', async () => {
      editionLinkState.proposed.value = { ...proposal, bookId: 10, title: 'Dune' }
      const panel = mountPanel(makeBook('m4b', 20))

      await panel.handleOpen()

      for (const args of editionLinkState.loadForBook.mock.calls) expect(args).toEqual([null])
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

    it('asks for an ebook on a link that has none', () => {
      editionLinkState.link.value = { ...linkRecord, textBookId: null, readAlongBookId: 30 }
      editionLinkState.role.value = 'audio'
      editionLinkState.members.value = { ...makeMembers(member(30, 'Dune (read-along)')), text: null }

      expect(mountPanel(makeBook('m4b', 20)).triggerTooltip.value).toBe('Link an ebook to enable position sync.')
    })

    it('leaves the icon neutral and names position sync before a link exists', () => {
      expect(mountPanel().triggerIconClass.value).toBe('')
      expect(mountPanel().triggerTooltip.value).toBe('Link an audiobook to enable position sync.')
      expect(mountPanel(makeBook('m4b', 20)).triggerTooltip.value).toBe('Link an ebook to enable position sync.')
    })
  })
})
