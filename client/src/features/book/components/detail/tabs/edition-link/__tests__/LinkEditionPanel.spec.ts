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
  ReadAloudProgressSync,
  StorytellerEffectiveTransport,
  StorytellerExistingMatch,
} from '@bookorbit/types'
import type { EditionLink, EditionLinkCandidate } from '@/features/book/composables/useEditionLink'
import type { ReadAlongBuildOutcome, ReadAlongCancelOutcome } from '@/features/book/composables/useReadAlong'
import type { AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import { useLinkEditionPanel, type EditionFilledSlot } from '@/features/book/composables/useLinkEditionPanel'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import LinkEditionPanel from '../LinkEditionPanel.vue'
import EditionPairBox from '../EditionPairBox.vue'
import EditionSlotCard from '../EditionSlotCard.vue'
import AudiobookshelfSyncStop from '../AudiobookshelfSyncStop.vue'

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

// The panel's host looks the Audiobookshelf link up and hands it down as props; tests stand in for it.
const absLinkState = {
  link: ref<import('@bookorbit/types').AudiobookshelfBookSyncLink | null>(null),
  live: ref<import('@bookorbit/types').AudiobookshelfBookSyncLive | null>(null),
  checking: ref(false),
}

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
    linkBook: vi.fn<(id: number, sourceBookId?: number) => Promise<boolean>>().mockResolvedValue(true),
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
    fetchStatus: vi.fn<(bookId: number, counterpartId?: number) => Promise<void>>().mockResolvedValue(undefined),
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

function mountPanelWithState(book = makeBook(), attachTo?: HTMLElement, extra: Record<string, unknown> = {}) {
  let state!: ReturnType<typeof useLinkEditionPanel>
  const Host = defineComponent({
    setup() {
      state = useLinkEditionPanel(() => book)
      const panel = reactive(state)
      return () =>
        h(LinkEditionPanel, {
          panel,
          absLink: absLinkState.link.value,
          absLive: absLinkState.live.value,
          absChecking: absLinkState.checking.value,
          ...extra,
        })
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

async function click(wrapper: ReturnType<typeof mountPanel>, testId: string) {
  await wrapper.get(`[data-testid="${testId}"]`).trigger('click')
}

// The switch only chooses; the button below it carries the link out.
async function linkFromPanel(wrapper: ReturnType<typeof mountPanel>) {
  await click(wrapper, 'position-sync-toggle')
  await click(wrapper, 'link-edition-cta')
  await flushPromises()
}

function text(wrapper: ReturnType<typeof mountPanel>, testId: string) {
  return wrapper.get(`[data-testid="${testId}"]`).text()
}

describe('LinkEditionPanel', () => {
  beforeEach(() => {
    absLinkState.link.value = null
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

    it('shows the pair apart with the auto-match chip, idle sections and the sync switch off', () => {
      const wrapper = mountPanel()

      expect(text(wrapper, 'link-edition-chip')).toBe('Ready to link')
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
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
    })

    it('only offers Link editions once the sync switch is on, and never links from the switch alone', async () => {
      const wrapper = mountPanel()

      await click(wrapper, 'position-sync-toggle')
      await flushPromises()

      expect(editionLinkState.linkBook).not.toHaveBeenCalled()
      expect(text(wrapper, 'link-edition-cta')).toBe('Link editions')

      await click(wrapper, 'position-sync-toggle')
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
    })

    it('links without a read-along when the read-along switch is off', async () => {
      const wrapper = mountPanel()

      await linkFromPanel(wrapper)

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.build).not.toHaveBeenCalled()
    })

    it('keeps the read-along switch disabled and off until the sync switch is on', async () => {
      const wrapper = mountPanel()
      const toggle = () => wrapper.get('[data-testid="read-along-toggle"]')
      expect(toggle().attributes('disabled')).toBeDefined()

      await click(wrapper, 'position-sync-toggle')
      await click(wrapper, 'read-along-toggle')
      expect(toggle().attributes('aria-checked')).toBe('true')

      await click(wrapper, 'position-sync-toggle')
      expect(toggle().attributes('disabled')).toBeDefined()
      expect(toggle().attributes('aria-checked')).toBe('false')
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)
    })

    it('links and generates with the keep-copy choice from the button, never from the switches', async () => {
      const wrapper = mountPanel()
      await click(wrapper, 'position-sync-toggle')
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)

      await click(wrapper, 'read-along-toggle')

      expect(editionLinkState.linkBook).not.toHaveBeenCalled()
      expect(readAlongState.build).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-destination"]').exists()).toBe(true)
      expect(text(wrapper, 'link-edition-cta')).toBe('Link & generate read-along')

      await click(wrapper, 'read-along-keep-copy')
      expect(readAlongState.setKeepRemoteCopy).toHaveBeenCalledWith(false)

      await click(wrapper, 'link-edition-cta')
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
    })

    it('shows the keep-copy choice even when Storyteller holds no reclaimable copy', async () => {
      readAlongState.remoteCopyReclaimable.value = false
      const wrapper = mountPanel()

      await click(wrapper, 'position-sync-toggle')
      await click(wrapper, 'read-along-toggle')

      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(true)
    })

    it('disables the button while the link is in flight', async () => {
      const wrapper = mountPanel()
      await click(wrapper, 'position-sync-toggle')
      editionLinkState.mutating.value = true
      await nextTick()

      expect(wrapper.get('[data-testid="link-edition-cta"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('disabled')).toBeDefined()
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
    it('names the missing format and hides the sections, the switch and the button', () => {
      const wrapper = mountPanel(makeBook('m4b'))

      expect(text(wrapper, 'link-edition-chip')).toBe('No match')
      expect(text(wrapper, 'link-edition-intro')).toBe("BookOrbit couldn't find a matching ebook in your libraries.")
      expect(wrapper.find('[data-testid="edition-slot-search-ebook"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="edition-connector"]').attributes('style')).toContain('display: none')
      expect(wrapper.find('[data-testid="position-sync"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
    })
  })

  describe('linking', () => {
    beforeEach(() => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
    })

    it('tightens the pair, spins the connector and cancels as soon as the switch goes off', async () => {
      const wrapper = mountPanel()
      await linkFromPanel(wrapper)
      alignmentState.status.value = 'building'
      alignmentState.samplesDone.value = 5
      alignmentState.samplesTotal.value = 10
      await nextTick()

      expect(text(wrapper, 'link-edition-chip')).toBe('Linking')
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      expect(text(wrapper, 'link-edition-intro')).toContain('Mapping audio to text.')
      expect(wrapper.get('[data-testid="edition-pair"]').classes()).toContain('gap-[5px]')
      expect(wrapper.find('[data-testid="edition-connector-spinner"]').exists()).toBe(true)
      expect(wrapper.findAll('[data-testid="position-sync-tick"]')).toHaveLength(10)

      await click(wrapper, 'position-sync-toggle')
      await flushPromises()
      expect(wrapper.findAllComponents(ConfirmDialog).every((dialog) => !dialog.props('open'))).toBe(true)
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(editionLinkState.unlink).toHaveBeenCalled()
    })

    it('keeps the pair box, chip and footer mounted while the link reloads', async () => {
      const { wrapper, state } = mountPanelWithState()
      await state.handleOpen()
      await flushPromises()
      const pair = wrapper.get('[data-testid="edition-pair"]').element

      editionLinkState.loading.value = true
      await linkFromPanel(wrapper)
      alignmentState.status.value = 'building'
      await nextTick()

      expect(wrapper.get('[data-testid="edition-pair"]').element).toBe(pair)
      expect(text(wrapper, 'link-edition-chip')).toBe('Linking')
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
    })

    it('reads the new pair so the read-along switch is usable instead of the pre-link block', async () => {
      readAlongState.blocked.value = 'no_pair'
      readAlongState.fetchStatus.mockImplementation(async () => {
        readAlongState.blocked.value = null
      })
      const wrapper = mountPanel()

      await linkFromPanel(wrapper)

      expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('none')
      expect(wrapper.find('[data-testid="read-along-blocked"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-toggle"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
    })
  })

  describe('choosing a read-along during the first alignment', () => {
    it('keeps Generate read-along once the alignment finishes', async () => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
      const wrapper = mountPanel()
      await linkFromPanel(wrapper)
      alignmentState.status.value = 'building'
      await nextTick()
      await click(wrapper, 'read-along-toggle')
      expect(text(wrapper, 'link-edition-cta')).toBe('Generate read-along')

      alignmentState.status.value = 'ready'
      alignmentState.builtAt.value = '2026-02-02T00:00:00.000Z'
      await nextTick()

      expect(wrapper.find('[data-testid="link-edition-chip"]').exists()).toBe(false)
      expect(text(wrapper, 'link-edition-cta')).toBe('Generate read-along')
    })

    it('holds the sync switch while a cancel of the alignment is in flight', async () => {
      editionLinkState.proposed.value = proposal
      linkOnClick()
      const wrapper = mountPanel()
      await linkFromPanel(wrapper)
      alignmentState.status.value = 'building'
      alignmentState.mutating.value = true
      await nextTick()

      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('disabled')).toBeDefined()
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

      await linkFromPanel(wrapper)

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

      await linkFromPanel(wrapper)

      const title = wrapper.get('[data-testid="edition-slot-read-along"] a')
      expect(title.text()).toBe('Dune (read-along)')
      expect(JSON.parse(title.attributes('href') ?? '{}')).toEqual({ name: 'book-detail', params: { bookId: 9 } })
      expect(wrapper.get('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-progress"]').text()).toBe('0%')

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
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
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
    it('narrates it as linking and cancels straight from the switch', async () => {
      linkPair()
      alignmentState.status.value = 'building'
      const wrapper = mountPanel()

      expect(wrapper.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('linking')
      expect(text(wrapper, 'link-edition-intro')).not.toBe('Positions sync between these editions.')

      await click(wrapper, 'position-sync-toggle')
      await flushPromises()
      expect(alignmentState.cancel).toHaveBeenCalledWith(10)
      expect(editionLinkState.unlink).toHaveBeenCalled()
    })

    it('turns the switch back on when the cancel is refused', async () => {
      linkPair()
      alignmentState.status.value = 'building'
      editionLinkState.unlink.mockResolvedValue(false)
      const wrapper = mountPanel()

      await click(wrapper, 'position-sync-toggle')
      await flushPromises()

      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
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
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      expect(text(wrapper, 'link-edition-intro')).toBe('Positions sync between these editions.')
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

    it('offers a read-along switch when none exists yet, and generates only from the button', async () => {
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="read-along-generate"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="read-along-toggle"]').attributes('aria-checked')).toBe('false')
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(false)

      await click(wrapper, 'read-along-toggle')

      expect(readAlongState.build).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="read-along-keep-copy-row"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-destination"]').exists()).toBe(true)
      expect(text(wrapper, 'link-edition-cta')).toBe('Generate read-along')

      await click(wrapper, 'link-edition-cta')
      await flushPromises()
      expect(readAlongState.build).toHaveBeenCalledWith(10, {})
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
    })

    it('holds the read-along switch off while the unlink awaits its confirm', async () => {
      const wrapper = mountPanel()
      await click(wrapper, 'read-along-toggle')

      await click(wrapper, 'position-sync-toggle')

      const toggle = wrapper.get('[data-testid="read-along-toggle"]')
      expect(toggle.attributes('disabled')).toBeDefined()
      expect(toggle.attributes('aria-checked')).toBe('false')
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
    })

    it('turns the switch back on when the unlink is not confirmed', async () => {
      const wrapper = mountPanel()

      await click(wrapper, 'position-sync-toggle')
      const dialog = wrapper.findAllComponents(ConfirmDialog).find((candidate) => candidate.props('title') === 'Unlink these editions?')!
      expect(dialog.props('open')).toBe(true)
      dialog.vm.$emit('cancel')
      await nextTick()

      expect(dialog.props('open')).toBe(false)
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('true')
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
    })

    it('gives the read-along choice back when the unlink is not confirmed', async () => {
      const wrapper = mountPanel()
      await click(wrapper, 'read-along-toggle')
      expect(text(wrapper, 'link-edition-cta')).toBe('Generate read-along')

      await click(wrapper, 'position-sync-toggle')
      const dialog = wrapper.findAllComponents(ConfirmDialog).find((candidate) => candidate.props('title') === 'Unlink these editions?')!
      dialog.vm.$emit('cancel')
      await nextTick()

      expect(wrapper.get('[data-testid="read-along-toggle"]').attributes('aria-checked')).toBe('true')
      expect(text(wrapper, 'link-edition-cta')).toBe('Generate read-along')
    })

    // The unlink reloads the for-book state like the real one, whose proposal is the pair just unlinked.
    it('still knows the pair has a read-along after the unlink, and does not offer to build one', async () => {
      linkPair(
        makeMembers({
          readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
        }),
      )
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
      editionLinkState.unlink.mockImplementation(async () => {
        editionLinkState.link.value = null
        editionLinkState.role.value = null
        editionLinkState.members.value = null
        editionLinkState.linkedCounterpart.value = null
        editionLinkState.proposed.value = proposal
        return true
      })
      readAlongState.reset.mockImplementation(() => {
        readAlongState.status.value = 'none'
        readAlongState.outputBook.value = null
      })
      readAlongState.fetchStatus.mockImplementation(async (_bookId: number, counterpartId?: number) => {
        if (counterpartId === 20) {
          readAlongState.status.value = 'ready'
          readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
        } else {
          readAlongState.status.value = 'none'
          readAlongState.blocked.value = 'no_pair'
          readAlongState.outputBook.value = null
        }
      })
      const wrapper = mountPanel()

      await click(wrapper, 'position-sync-toggle')
      wrapper.findAllComponents(ConfirmDialog)[0].vm.$emit('confirm')
      await flushPromises()

      expect(wrapper.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('matched')
      expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe('offerExisting')

      await click(wrapper, 'position-sync-toggle')
      expect(text(wrapper, 'link-edition-cta')).toBe('Link editions')
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

      await click(wrapper, 'position-sync-toggle')
      expect(editionLinkState.unlink).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      const dialog = wrapper.findAllComponents(ConfirmDialog)[0]
      expect(dialog.props('open')).toBe(true)
      expect(dialog.props('description')).toBe('Their positions stop syncing with each other. The read-along book stays in its library.')
      dialog.vm.$emit('confirm')
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('Books unlinked.')
    })

    it.each(['building', 'failed'] as ReadAlongStatus[])(
      'keeps the read-along as the third stop and narrates a %s rebuild, without Rebuild',
      (status) => {
        linkPair(
          makeMembers({
            readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
          }),
        )
        readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
        readAlongState.status.value = status
        const wrapper = mountPanel()

        expect(wrapper.find('[data-testid="edition-slot-read-along"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="edition-slot-rebuild"]').exists()).toBe(false)
        expect(wrapper.get('[data-testid="read-along-section"]').attributes('data-state')).toBe(status)
      },
    )

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
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-this-book"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)

      await wrapper.get('[data-testid="position-sync-build"]').trigger('click')
      await flushPromises()
      expect(alignmentState.build).toHaveBeenCalledWith(10, true)

      await click(wrapper, 'position-sync-toggle')
      wrapper.findAllComponents(ConfirmDialog)[0].vm.$emit('confirm')
      await flushPromises()
      expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
    })
  })

  describe('on a read-along detached from its pair', () => {
    const readAlongMember = { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null }

    beforeEach(() => {
      editionLinkState.role.value = 'readAlong'
      editionLinkState.members.value = makeMembers({ readAlong: readAlongMember })
      readAlongState.status.value = 'ready'
      readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
    })

    it('shows the pair unlinked with the read-along as its third stop, and nothing to change or generate', () => {
      const wrapper = mountPanel(makeBook('epub', 30))

      expect(wrapper.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('matched')
      expect(text(wrapper, 'link-edition-chip')).toBe('Ready to link')
      expect(text(wrapper, 'link-edition-intro')).toContain('This read-along was generated from these editions.')
      expect(text(wrapper, 'edition-slot-ebook')).toContain('Dune')
      expect(text(wrapper, 'edition-slot-audiobook')).toContain('Dune (audio)')
      expect(wrapper.find('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-this-book"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="edition-slot-rebuild"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="edition-connector-read-along"]').classes()).not.toContain('bg-success')
      expect(wrapper.find('[data-testid="edition-slot-change"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-search-input"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-section"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="position-sync-toggle"]').attributes('aria-checked')).toBe('false')
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
    })

    it('links the pair through its ebook, and shows the three linked once the link carries the read-along', async () => {
      editionLinkState.linkBook.mockImplementation(async () => {
        editionLinkState.link.value = { ...linkRecord, readAlongBookId: 30 }
        return true
      })
      const wrapper = mountPanel(makeBook('epub', 30))

      await click(wrapper, 'position-sync-toggle')
      expect(editionLinkState.linkBook).not.toHaveBeenCalled()
      expect(text(wrapper, 'link-edition-cta')).toBe('Link editions')

      await click(wrapper, 'link-edition-cta')
      await flushPromises()

      expect(editionLinkState.linkBook).toHaveBeenCalledWith(20, 10)
      expect(alignmentState.build).toHaveBeenCalledWith(10)
      expect(readAlongState.build).not.toHaveBeenCalled()
      expect(wrapper.get('[data-testid="link-edition-panel"]').attributes('data-phase')).toBe('linked')
      expect(wrapper.get('[data-testid="edition-connector-read-along"]').classes()).toContain('bg-success')
    })
  })

  describe('without the edit permission', () => {
    beforeEach(() => {
      permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_edit_metadata')
    })

    it('hides Change and the switches on a proposed match', () => {
      editionLinkState.proposed.value = proposal
      const wrapper = mountPanel()

      expect(wrapper.find('[data-testid="edition-slot-change"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="read-along-toggle"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
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
      expect(building.find('[data-testid="link-edition-footer"]').exists()).toBe(false)

      alignmentState.status.value = 'ready'
      const linked = mountPanel()
      expect(linked.find('[data-testid="position-sync-toggle"]').exists()).toBe(false)
      expect(linked.find('[data-testid="link-edition-footer"]').exists()).toBe(false)
      expect(linked.find('[data-testid="position-sync-build"]').exists()).toBe(false)
    })
  })
})

describe('LinkEditionPanel Audiobookshelf stop', () => {
  beforeEach(() => {
    editionLinkState = createEditionLinkState()
    alignmentState = createAlignmentState()
    readAlongState = createReadAlongState()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
    absLinkState.link.value = null
    absLinkState.live.value = null
    absLinkState.checking.value = false
  })

  const STOP_ORDER_SELECTOR =
    '[data-testid="edition-slot-ebook"], [data-testid="edition-slot-audiobook"], [data-testid="edition-slot-read-along"], [data-testid="edition-abs-stop"]'

  function stopOrder(wrapper: {
    get: (selector: string) => { findAll: (selector: string) => { attributes: (name: string) => string | undefined }[] }
  }) {
    return wrapper
      .get('[data-testid="edition-pair"]')
      .findAll(STOP_ORDER_SELECTOR)
      .map((node) => node.attributes('data-testid'))
  }

  const absLink = {
    audioBookId: 20,
    absLibraryItemId: 'abs-1',
    title: 'Dune (ABS)',
    authorName: null,
    libraryName: 'Fiction',
    direction: 'two_way' as const,
    webUrl: null,
  }

  it('places the Audiobookshelf stop right after the audiobook it is matched to', async () => {
    linkPair()
    absLinkState.link.value = absLink
    const wrapper = mountPanel()
    await flushPromises()

    const order = wrapper
      .get('[data-testid="edition-pair"]')
      .findAll(
        '[data-testid="edition-slot-ebook"], [data-testid="edition-slot-audiobook"], [data-testid="edition-slot-read-along"], [data-testid="edition-abs-stop"]',
      )
      .map((node) => node.attributes('data-testid'))
    expect(order).toEqual(['edition-slot-ebook', 'edition-slot-audiobook', 'edition-abs-stop'])
    expect(wrapper.get('[data-testid="edition-abs-stop"]').text()).toContain('Dune (ABS)')
  })

  it('renders the checking shimmer, then the live progress, through the panel', async () => {
    linkPair()
    absLinkState.link.value = absLink
    absLinkState.checking.value = true
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="edition-abs-checking"]').exists()).toBe(true)

    absLinkState.checking.value = false
    absLinkState.live.value = { status: 'synced', progress: { percentage: 64, isFinished: false, lastUpdate: 1 }, local: null, divergedReason: null }
    await flushPromises()
    expect(wrapper.find('[data-testid="edition-abs-checking"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="edition-abs-progress"]').text()).toContain('64%')
  })

  it('keeps the stop after the pair and before the read-along, with the cards closing the rail', async () => {
    editionLinkState.link.value = { ...linkRecord, readAlongBookId: 30 }
    editionLinkState.role.value = 'audio'
    editionLinkState.members.value = makeMembers({
      readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
    })
    readAlongState.status.value = 'ready'
    alignmentState.status.value = 'ready'
    absLinkState.link.value = absLink
    const wrapper = mountPanel(makeBook('m4b', 20))
    await flushPromises()

    expect(stopOrder(wrapper)).toEqual(['edition-slot-ebook', 'edition-slot-audiobook', 'edition-abs-stop', 'edition-slot-read-along'])
    expect(wrapper.findAllComponents(EditionSlotCard).map((card) => card.props('position'))).toEqual(['top', 'middle', 'bottom'])
    expect(wrapper.getComponent(AudiobookshelfSyncStop).props('position')).toBe('middle')
  })

  describe('read-aloud sync that a rebuild fixes', () => {
    function linkWithReadAlong() {
      editionLinkState.link.value = { ...linkRecord, readAlongBookId: 30 }
      editionLinkState.role.value = 'audio'
      editionLinkState.members.value = makeMembers({
        readAlong: { id: 30, title: 'Dune (read-along)', authorName: null, coverVersion: null, progress: null, narrationPercentage: null },
      })
      readAlongState.status.value = 'ready'
      alignmentState.status.value = 'ready'
    }

    function readAloudSync(overrides: Partial<ReadAloudProgressSync> = {}): ReadAloudProgressSync {
      return {
        mode: 'auto',
        state: 'unavailable',
        unavailableReason: 'audio_changed',
        overlayFileId: 300,
        audioDurationSeconds: null,
        overlayDurationSeconds: null,
        durationDifferenceSeconds: null,
        durationDifferenceRatio: null,
        koreaderDownloadAvailable: false,
        narrationMismatch: null,
        offsetsSource: null,
        ...overrides,
      }
    }

    it('flags the read-along row and rebuilds it behind the same confirm', async () => {
      linkWithReadAlong()
      const wrapper = mountPanelWithState(makeBook('m4b', 20), undefined, { readAloudSync: readAloudSync() }).wrapper
      await flushPromises()

      const issue = wrapper.get('[data-testid="edition-slot-read-along"] [data-testid="edition-slot-sync-issue"]')
      expect(issue.text()).toBe('Not syncing')
      expect(issue.attributes('data-reason')).toBe('audio_changed')
      expect(text(wrapper, 'edition-slot-sync-issue-detail')).toContain('The audiobook files changed after this read-along was built.')
      expect(wrapper.find('[data-testid="edition-slot-rebuild"]').exists()).toBe(false)

      await click(wrapper, 'edition-slot-sync-issue-rebuild')
      const dialog = wrapper.findAllComponents(ConfirmDialog).find((candidate) => candidate.props('open'))!
      dialog.vm.$emit('confirm')
      await flushPromises()

      expect(readAlongState.build).toHaveBeenCalledWith(20, { force: true })
    })

    it('names the narration file and chapter that do not fit', async () => {
      linkWithReadAlong()
      const sync = readAloudSync({
        unavailableReason: 'narration_mismatch',
        narrationMismatch: { narrationFile: 2, narrationSeconds: 600, chapter: 3, chapterSeconds: 640 },
      })
      const wrapper = mountPanelWithState(makeBook('m4b', 20), undefined, { readAloudSync: sync }).wrapper
      await flushPromises()

      expect(text(wrapper, 'edition-slot-sync-issue-detail')).toContain('file 2 is 10:00, chapter 3 is 10:40.')
    })

    it('shows nothing new while read-aloud sync is enabled', async () => {
      linkWithReadAlong()
      const sync = readAloudSync({ state: 'enabled', unavailableReason: null, offsetsSource: 'match' })
      const wrapper = mountPanelWithState(makeBook('m4b', 20), undefined, { readAloudSync: sync }).wrapper
      await flushPromises()

      expect(wrapper.find('[data-testid="edition-slot-sync-issue"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="edition-slot-rebuild"]').exists()).toBe(true)
    })

    it('opens the rebuild confirm when asked from outside the panel', async () => {
      linkWithReadAlong()
      const handled = vi.fn<() => void>()
      const wrapper = mountPanelWithState(makeBook('m4b', 20), undefined, {
        readAloudSync: readAloudSync(),
        readAlongRebuildRequested: true,
        onReadAlongRebuildRequestHandled: handled,
      }).wrapper
      await flushPromises()

      const dialog = wrapper.findAllComponents(ConfirmDialog).find((candidate) => candidate.props('title') === 'Replace this read-along?')
      expect(dialog?.props('open')).toBe(true)
      expect(handled).toHaveBeenCalled()
    })
  })

  it('asks for a fresh Audiobookshelf status when the stop wants one', async () => {
    linkPair()
    absLinkState.link.value = absLink
    absLinkState.live.value = { status: 'unreachable', progress: null, local: null, divergedReason: null }
    const refresh = vi.fn<() => void>()
    const wrapper = mountPanelWithState(makeBook(), undefined, { onRefreshAbsLive: refresh }).wrapper
    await flushPromises()

    await click(wrapper, 'edition-abs-retry')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  describe('with the audiobook in either slot', () => {
    const ebookSlot: EditionFilledSlot = {
      kind: 'filled',
      format: 'ebook',
      bookId: 10,
      coverVersion: null,
      title: 'Dune',
      authorName: null,
      progress: null,
      isThisBook: false,
      match: null,
      canChange: false,
    }
    const audiobookSlot: EditionFilledSlot = { ...ebookSlot, format: 'audiobook', bookId: 20, title: 'Dune (audio)', isThisBook: true }
    const readAlongSlot: EditionFilledSlot = { ...ebookSlot, bookId: 30, title: 'Dune (read-along)', readAlong: true }

    function mountBox(slots: [EditionFilledSlot, EditionFilledSlot], readAlong: EditionFilledSlot | null) {
      return mount(EditionPairBox, {
        props: {
          phase: 'linked',
          slots,
          readAlong,
          absLink,
          canSearch: false,
          query: '',
          candidates: [],
          searching: false,
          searchError: null,
          hasSearched: false,
          searchAutofocus: false,
          disabled: false,
        },
        global: { stubs },
      })
    }

    it.each([
      ['slot 0', [audiobookSlot, ebookSlot], null, ['edition-slot-audiobook', 'edition-slot-ebook', 'edition-abs-stop'], 'bottom'],
      ['slot 1', [ebookSlot, audiobookSlot], null, ['edition-slot-ebook', 'edition-slot-audiobook', 'edition-abs-stop'], 'bottom'],
      [
        'slot 0 with a read-along',
        [audiobookSlot, ebookSlot],
        readAlongSlot,
        ['edition-slot-audiobook', 'edition-slot-ebook', 'edition-abs-stop', 'edition-slot-read-along'],
        'middle',
      ],
      [
        'slot 1 with a read-along',
        [ebookSlot, audiobookSlot],
        readAlongSlot,
        ['edition-slot-ebook', 'edition-slot-audiobook', 'edition-abs-stop', 'edition-slot-read-along'],
        'middle',
      ],
    ] as const)('places the stop after the pair with the audiobook in %s', (_label, slots, readAlong, order, absPosition) => {
      const wrapper = mountBox([slots[0], slots[1]], readAlong)

      expect(stopOrder(wrapper)).toEqual(order)
      const positions = wrapper.findAllComponents(EditionSlotCard).map((card) => card.props('position'))
      expect(positions).toEqual(readAlong ? ['top', 'middle', 'bottom'] : ['top', 'middle'])
      expect(wrapper.getComponent(AudiobookshelfSyncStop).props('position')).toBe(absPosition)
    })
  })

  it('shows no stop when the item belongs to a different audiobook or there is none', async () => {
    linkPair()
    absLinkState.link.value = { ...absLink, audioBookId: 99 }
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="edition-abs-stop"]').exists()).toBe(false)

    absLinkState.link.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="edition-abs-stop"]').exists()).toBe(false)
  })
})
