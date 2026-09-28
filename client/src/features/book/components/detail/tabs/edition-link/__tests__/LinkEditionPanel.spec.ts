import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
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
import type { EditionLink, EditionLinkCandidate } from '@/features/book/composables/useEditionLink'
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '@/features/book/composables/useReadAlong'
import type { AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import { useLinkEditionPanel } from '@/features/book/composables/useLinkEditionPanel'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import LinkEditionPanel from '../LinkEditionPanel.vue'

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

const linkRecord: EditionLink = { id: 1, textBookId: 10, audioBookId: 20, readAlongBookId: null, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }

function makeMembers(overrides: Partial<EditionLinkMembers> = {}): EditionLinkMembers {
  return {
    text: {
      id: 10,
      title: 'Dune',
      authorName: 'Frank Herbert',
      coverVersion: null,
      progress: { percentage: 26, updatedAt: '2026-09-01' },
      narrationPercentage: null,
    },
    audio: {
      id: 20,
      title: 'Dune (audio)',
      authorName: 'Frank Herbert',
      coverVersion: null,
      progress: { percentage: 27, updatedAt: '2026-09-01' },
      narrationPercentage: null,
    },
    readAlong: null,
    ...overrides,
  }
}

function createEditionLinkState() {
  return {
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
    linkBook: vi.fn<(id: number) => Promise<boolean>>().mockResolvedValue(true),
    unlink: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    resetSearch: vi.fn<() => void>(),
  }
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
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<(id: number, force?: boolean) => Promise<void>>().mockResolvedValue(undefined),
    cancel: vi.fn<(id: number) => Promise<boolean>>().mockResolvedValue(true),
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
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<() => Promise<ReadAlongBuildOutcome>>().mockResolvedValue('started'),
    cancel: vi.fn<(id: number) => Promise<ReadAlongCancelOutcome>>().mockResolvedValue('cancelled'),
    fetchExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onReady: vi.fn<(handler: () => void) => void>(),
    reset: vi.fn<() => void>(),
  }
}

let editionLinkState = createEditionLinkState()
let alignmentState = createAlignmentState()
let readAlongState = createReadAlongState()

vi.mock('@/features/book/composables/useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLinkState }
})
vi.mock('@/features/book/composables/useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('@/features/book/composables/useReadAlong', () => ({ useReadAlong: () => readAlongState }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))

const stubs = {
  RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' },
  ConfirmDialog: { props: ['open', 'title', 'description', 'confirmLabel', 'busy'], emits: ['confirm', 'cancel'], template: '<div />' },
}

function makeBook(format: 'epub' | 'm4b' = 'epub', id = 10): BookDetail {
  return {
    id,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    files: [{ id: 1, format, role: 'content' }],
  } as unknown as BookDetail
}

const proposal: EditionLinkCandidate = { bookId: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null, score: 96 }

function mountPanelWithState(book = makeBook(), attachTo?: HTMLElement) {
  let state!: ReturnType<typeof useLinkEditionPanel>
  const Host = defineComponent({
    setup() {
      state = useLinkEditionPanel(() => book)
      const panel = reactive(state)
      return () => h(LinkEditionPanel, { panel })
    },
  })
  const wrapper = mount(Host, { global: { stubs }, attachTo })
  return { wrapper, state }
}

function mountPanel(book = makeBook()) {
  return mountPanelWithState(book).wrapper
}

// The link a CTA click creates, so the panel narrates the first alignment as linking.
function linkOnClick(members = makeMembers()) {
  editionLinkState.linkBook.mockImplementation(async () => {
    linkPair(members)
    return true
  })
}

function linkPair(members = makeMembers()) {
  editionLinkState.link.value = linkRecord
  editionLinkState.role.value = 'text'
  editionLinkState.members.value = members
  editionLinkState.linkedCounterpart.value = { id: 20, title: 'Dune (audio)', authorName: 'Frank Herbert', coverVersion: null }
}

function text(wrapper: ReturnType<typeof mountPanel>, testId: string) {
  return wrapper.get(`[data-testid="${testId}"]`).text()
}

describe('LinkEditionPanel', () => {
  beforeEach(() => {
    editionLinkState = createEditionLinkState()
    alignmentState = createAlignmentState()
    readAlongState = createReadAlongState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  describe('matched', () => {
    beforeEach(() => {
      editionLinkState.proposed.value = proposal
    })

    it('shows the pair apart with the auto-match chip, idle sections and the link CTA', () => {
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(text(wrapper, 'link-edition-intro')).toBe('BookOrbit found a matching pair. Review and link.')
      expect(wrapper.get('[data-testid="edition-pair"]').classes()).toContain('gap-[7px]')
      expect(wrapper.get('[data-testid="edition-slot-ebook"]').classes()).not.toContain('pb-2')
      expect(wrapper.get('[data-testid="edition-slot-audiobook"]').classes()).not.toContain('pt-2')
      expect(wrapper.get('[data-testid="edition-rail"]').classes()).toContain('opacity-0')
      expect(text(wrapper, 'edition-slot-ebook')).toContain('This book')
      expect(text(wrapper, 'edition-slot-match')).toBe('Auto-matched · 96%')
      expect(wrapper.find('[data-testid="position-sync-build"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('offerOff')
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('false')
    })

    it('links with a read-along build when position sync is turned on after the read-along toggle', async () => {
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="read-along-toggle"]').trigger('click')

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
    })

    it('turns the counterpart into the search slot on Change, and back on a pick', async () => {
      editionLinkState.candidates.value = [proposal, { bookId: 21, title: 'Dune Messiah (audio)', authorName: null, coverVersion: null, score: 40 }]
      const { wrapper } = mountPanelWithState(makeBook(), document.body)

      await wrapper.get('[data-testid="edition-slot-change"]').trigger('click')
      expect(wrapper.find('[data-testid="edition-slot-search-audiobook"]').exists()).toBe(true)
      expect(document.activeElement).toBe(wrapper.get('[data-testid="edition-search-input"]').element)
      expect(text(wrapper, 'link-edition-chip')).toBe('No match')
      expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('')

      await wrapper.findAll('[data-testid="edition-search-result"]')[1]?.trigger('click')

      expect(text(wrapper, 'edition-slot-match')).toBe('Selected')
      expect(text(wrapper, 'edition-slot-audiobook')).toContain('Dune Messiah (audio)')
      expect(editionLinkState.linkBook).not.toHaveBeenCalled()
      wrapper.unmount()
    })
  })

  describe('without the upload permission', () => {
    it('offers the link without a read-along section before linking', () => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_upload')
      editionLinkState.proposed.value = proposal
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="position-sync-toggle"]').exists()).toBe(true)
    })
  })

  describe('nomatch', () => {
    it('names the missing format and hides the sections and footer', () => {
      const wrapper = mountPanel(makeBook('m4b'))

      expect(text(wrapper, 'link-edition-chip')).toBe('No match')
      expect(text(wrapper, 'link-edition-intro')).toBe("BookOrbit couldn't find a matching ebook in your libraries.")
      expect(wrapper.find('[data-testid="edition-slot-search-ebook"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="edition-connector"]').attributes('style')).toContain('display: none')
      expect(wrapper.find('[data-testid="position-sync"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
    })
  })

  describe('linking', () => {
    beforeEach(() => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
    })

    it('tightens the pair, spins the connector and cancels when turned off', async () => {
      const wrapper = mountPanel()
      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()
      alignmentState.status.value = 'building'
      alignmentState.samplesDone.value = 5
      alignmentState.samplesTotal.value = 10
      await nextTick()

      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(text(wrapper, 'link-edition-intro')).toContain('Mapping audio to text.')
      expect(wrapper.get('[data-testid="edition-pair"]').classes()).toContain('gap-[5px]')
      expect(wrapper.find('[data-testid="edition-connector-spinner"]').exists()).toBe(true)
      expect(wrapper.findAll('[data-testid="position-sync-tick"]')).toHaveLength(10)

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalled()
    })

    it('keeps the pair box, chip and footer mounted while the link reloads', async () => {
      const { wrapper, state } = mountPanelWithState()
      await state.handleOpen()
      await flushPromises()
      const pair = wrapper.get('[data-testid="edition-pair"]').element

      editionLinkState.loading.value = true
      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()
      alignmentState.status.value = 'building'
      await nextTick()

      expect(wrapper.get('[data-testid="edition-pair"]').element).toBe(pair)
      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
    })

    it('reads the new pair so the read-along section offers Generate instead of the pre-link block', async () => {
      readAlongState.blocked.value = 'no_pair'
      readAlongState.fetchStatus.mockImplementation(async () => {
        readAlongState.blocked.value = null
      })
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('none')
      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-generate"]').attributes('disabled')).toBeUndefined()
    })
  })

  describe('relinking a pair whose read-along still exists', () => {
    it('reloads the link once the status names the read-along, and shows it', async () => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
      const readAlongMember = { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null }
      editionLinkState.loadForBook.mockImplementation(async () => {
        linkPair(makeMembers({ readAlong: readAlongMember }))
      })
      readAlongState.fetchStatus.mockImplementation(async () => {
        readAlongState.status.value = 'ready'
        readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      })
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()

      expect(editionLinkState.loadForBook).toHaveBeenCalledTimes(1)
      expect(text(wrapper, 'edition-slot-read-along')).toContain('Dune (read-along)')
      expect(wrapper.find('[data-testid="read-along-ready"]').exists()).toBe(false)
    })
  })

  describe('relinking a pair the server has not re-attached its read-along to yet', () => {
    it('names the read-along from the status read until the link carries it', async () => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
      readAlongState.fetchStatus.mockImplementation(async () => {
        readAlongState.status.value = 'ready'
        readAlongState.outputBook.value = { id: 9, title: 'Dune (read-along)' }
      })
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      await flushPromises()

      const title = wrapper.get('[data-testid="edition-slot-read-along"] a')
      expect(title.text()).toBe('Dune (read-along)')
      expect(JSON.parse(title.attributes('href') ?? '{}')).toEqual({ name: 'book-detail', params: { bookId: 9 } })
      expect(wrapper.find('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-progress"]').exists()).toBe(false)

      linkPair(
        makeMembers({
          readAlong: {
            id: 9,
            title: 'Dune (read-along)',
            authorName: null,
            coverVersion: null,
            progress: { percentage: 42, updatedAt: '2026-09-01' },
            narrationPercentage: 37,
          },
        }),
      )
      await flushPromises()

      expect(wrapper.get('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-progress"]').attributes('aria-label')).toBe('42% read')
    })
  })

  describe('rebuilding position sync on an established pair', () => {
    it('stays merged and narrates the rebuild in the header', () => {
      linkPair()
      alignmentState.status.value = 'building'
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      const wrapper = mountPanel()

      expect(text(wrapper, 'link-edition-chip')).toBe('Aligning')
      expect(wrapper.get('[data-testid="edition-pair"]').classes()).toContain('gap-0')
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(wrapper.find('[data-testid="position-sync-indeterminate"]').exists()).toBe(true)
      const connector = wrapper.get('[data-testid="edition-connector"]')
      expect(connector.classes()).toContain('bg-info')
      expect(connector.classes()).not.toContain('bg-success')
      expect(wrapper.find('[data-testid="edition-connector-spinner"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="edition-rail"]').classes()).toContain('bg-info/40')
    })
  })

  // Opened on the other edition's page, or reopened: the panel never saw the link being made.
  describe('a first alignment the panel did not start', () => {
    it('narrates it as linking and offers Cancel', () => {
      linkPair()
      alignmentState.status.value = 'building'
      const wrapper = mountPanel()

      expect(wrapper.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('linking')
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(text(wrapper, 'link-edition-intro')).not.toBe('Progress syncs between these editions.')
    })
  })

  describe('linked', () => {
    beforeEach(() => {
      linkPair()
      alignmentState.status.value = 'ready'
    })

    it('merges the pair and shows progress, the synced map and Unlink', () => {
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(text(wrapper, 'link-edition-intro')).toBe('Progress syncs between these editions.')
      const pair = wrapper.get('[data-testid="edition-pair"]')
      expect(pair.classes()).toContain('gap-0')
      expect(wrapper.get('[data-testid="edition-rail"]').classes()).toContain('opacity-100')
      expect(wrapper.get('[data-testid="edition-connector"]').classes()).toContain('left-5')
      expect(wrapper.get('[data-testid="edition-connector"]').classes()).toContain('bg-success')
      expect(wrapper.get('[data-testid="edition-slot-ebook"]').classes()).toContain('pb-2')
      expect(wrapper.get('[data-testid="edition-slot-audiobook"]').classes()).toContain('pt-2')
      expect(text(wrapper, 'edition-slot-ebook')).toContain('26%')
      expect(text(wrapper, 'edition-slot-ebook')).not.toContain('read')
      expect(wrapper.get('[data-testid="edition-slot-ebook"] [data-testid="edition-slot-progress"]').attributes('aria-label')).toBe('26% read')
      expect(wrapper.get('[data-testid="edition-slot-audiobook"] [data-testid="edition-slot-progress"]').attributes('aria-label')).toBe(
        '27% listened',
      )
      expect(wrapper.find('[data-testid="link-edition-unlink-note"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="edition-slot-ebook"] [data-testid="edition-cover"]').attributes('data-medium')).toBe('ebook')
      expect(wrapper.get('[data-testid="edition-slot-audiobook"] [data-testid="edition-cover"]').attributes('data-medium')).toBe('audio')
      expect(wrapper.find('[data-testid="position-sync"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-read-along"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('none')
    })

    it('asks before unlinking, notes that the read-along stays, and unlinks', async () => {
      linkPair(
        makeMembers({
          readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
        }),
      )
      readAlongState.status.value = 'ready'
      const wrapper = mountPanel()
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-slot-rebuild"]').exists()).toBe(true)

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
      const dialog = wrapper.findAllComponents(ConfirmDialog)[0]
      expect(dialog.props('open')).toBe(true)
      expect(dialog.props('description')).toBe('Their positions stop syncing with each other. The read-along book stays in its library.')
      dialog.vm.$emit('confirm')
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('Books unlinked.')
    })

    it('cancels a running read-along build from the section', async () => {
      readAlongState.status.value = 'building'
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="read-along-cancel"]').trigger('click')
      await flushPromises()

      expect(readAlongState.cancel).toHaveBeenCalledWith(10)
    })

    it.each([
      ['failed', 'Failed', 'Position sync failed. Rebuild to try again.'],
      ['unalignable', "Can't align", "Position sync isn't available for this book pair."],
    ] as [AlignmentStatus, string, string][])('names the sync problem instead of promising synced progress when %s', (status, chip, intro) => {
      alignmentState.status.value = status
      const wrapper = mountPanel()

      expect(text(wrapper, 'link-edition-chip')).toBe(chip)
      expect(text(wrapper, 'link-edition-intro')).toBe(intro)
      expect(wrapper.get('[data-testid="edition-connector"]').classes()).not.toContain('bg-success')
      expect(wrapper.get('[data-testid="edition-rail"]').classes()).toContain('bg-border')
    })

    it('shows why position sync failed', () => {
      alignmentState.status.value = 'failed'
      alignmentState.buildError.value = 'whisper was killed by SIGILL'
      const wrapper = mountPanel()

      expect(text(wrapper, 'position-sync-build-error')).toBe('whisper was killed by SIGILL')
    })

    it('rebuilds the position sync with force from the header', async () => {
      const wrapper = mountPanel()

      await wrapper.get('[data-testid="position-sync-build"]').trigger('click')
      await flushPromises()

      expect(alignmentState.build).toHaveBeenCalledWith(10, true)
    })
  })

  describe('on the read-along book page', () => {
    it("manages the link through the pair's ebook", async () => {
      editionLinkState.link.value = { ...linkRecord, readAlongBookId: 30 }
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers({
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
      })
      readAlongState.status.value = 'ready'
      alignmentState.status.value = 'ready'
      const wrapper = mountPanel(makeBook('epub', 30))

      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-this-book"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)

      await wrapper.get('[data-testid="position-sync-build"]').trigger('click')
      await flushPromises()
      expect(alignmentState.build).toHaveBeenCalledWith(10, true)

      await wrapper.get('[data-testid="position-sync-toggle"]').trigger('click')
      wrapper.findAllComponents(ConfirmDialog)[0].vm.$emit('confirm')
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
    })
  })

  describe('without the edit permission', () => {
    beforeEach(() => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_edit_metadata')
    })

    it('hides Change, the toggle and the CTA on a proposed match', () => {
      editionLinkState.proposed.value = proposal
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="edition-slot-change"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-toggle"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
    })

    it('presents a proposed match as a suggestion, without sections', () => {
      editionLinkState.proposed.value = proposal
      const wrapper = mountPanel()

      expect(text(wrapper, 'link-edition-chip')).toBe('Suggested match')
      expect(text(wrapper, 'link-edition-intro')).toBe('BookOrbit found a matching pair.')
      expect(wrapper.find('[data-testid="position-sync"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
    })

    it('hides the search on an unmatched book', () => {
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="edition-search-input"]').exists()).toBe(false)
    })

    it('hides Cancel and Unlink, even during a first alignment', () => {
      linkPair()
      alignmentState.status.value = 'building'
      const building = mountPanel()
      expect(building.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('linking')
      expect(building.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)

      alignmentState.status.value = 'ready'
      const linked = mountPanel()
      expect(linked.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
      expect(linked.find('[data-testid="position-sync-build"]').exists()).toBe(false)
    })
  })
})
