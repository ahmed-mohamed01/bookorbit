import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import type { BookDetail, ReadAloudProgressSync } from '@bookorbit/types'
import {
  calls,
  createAbsState,
  createAlignmentState,
  createEditionLinkState,
  createReadAlongState,
  linkRecord,
  makeMembers,
  member,
} from '@/features/book/composables/__tests__/sync-chain-panel-mocks'
import { useSyncChainPanel, type SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainViewMode } from '@/features/book/lib/sync-chain'
import EditionSlotSearch from '../EditionSlotSearch.vue'
import SyncChainPanel from '../SyncChainPanel.vue'

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

let editionLinkState = createEditionLinkState()
let alignmentState = createAlignmentState()
let readAlongState = createReadAlongState()
let absState = createAbsState()

vi.mock('@/features/book/composables/useEditionLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/book/composables/useEditionLink')>()
  return { ...actual, useEditionLink: () => editionLinkState }
})
vi.mock('@/features/book/composables/useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('@/features/book/composables/useReadAlong', () => ({ useReadAlong: () => readAlongState }))
vi.mock('@/features/book/composables/useAudiobookshelfSyncLink', () => ({ useAudiobookshelfSyncLink: () => absState }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }),
}))

const ConfirmDialogStub = {
  name: 'ConfirmDialog',
  props: ['open', 'title', 'description', 'confirmLabel', 'busy', 'destructive'],
  emits: ['confirm', 'cancel'],
  template:
    '<div v-if="open" data-testid="confirm-dialog" :data-destructive="destructive"><p data-testid="confirm-title">{{ title }}</p><p data-testid="confirm-description">{{ description }}</p><button data-testid="confirm-label">{{ confirmLabel }}</button></div>',
}

const stubs = {
  ConfirmDialog: ConfirmDialogStub,
  RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' },
}

const noIssue = { mode: 'auto', state: 'unavailable', unavailableReason: 'no_media_overlay_epub' } as ReadAloudProgressSync

function makeBook(): BookDetail {
  return {
    id: 10,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    files: [{ id: 1, format: 'epub', role: 'content' }],
    readAloudSync: noIssue,
  } as unknown as BookDetail
}

interface MountOptions {
  height?: number
  force?: ChainViewMode
  open?: boolean
}

async function mountPanel({ height = 10_000, force, open = true }: MountOptions = {}) {
  let panel!: SyncChainPanelView
  const requested = ref(false)
  const Host = defineComponent({
    setup() {
      panel = reactive(useSyncChainPanel(makeBook))
      return () =>
        h(SyncChainPanel, {
          panel,
          readAlongRebuildRequested: requested.value,
          onReadAlongRebuildRequestHandled: () => {
            requested.value = false
          },
        })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { stubs } })
  if (open) {
    panel.prepareView(height, force)
    await panel.handleOpen()
    await flushPromises()
  }
  return { wrapper, panel, requested }
}

function alignedPair(withReadAlong = false) {
  const readAlong = withReadAlong ? member(30, 'Dune (read-along)') : null
  editionLinkState.link.value = readAlong ? { ...linkRecord, readAlongBookId: 30 } : linkRecord
  editionLinkState.role.value = 'text'
  editionLinkState.members.value = makeMembers(readAlong)
  alignmentState.status.value = 'ready'
  alignmentState.builtAt.value = '2026-10-01T00:00:00.000Z'
  if (withReadAlong) {
    readAlongState.status.value = 'ready'
    readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
  }
}

function syncingAbsMatch() {
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
  }
}

function dialogText(wrapper: Awaited<ReturnType<typeof mountPanel>>['wrapper']) {
  return {
    title: wrapper.get('[data-testid="confirm-title"]').text(),
    description: wrapper.get('[data-testid="confirm-description"]').text(),
    confirmLabel: wrapper.get('[data-testid="confirm-label"]').text(),
    destructive: wrapper.get('[data-testid="confirm-dialog"]').attributes('data-destructive'),
  }
}

const switchOf = (wrapper: Awaited<ReturnType<typeof mountPanel>>['wrapper'], key: string) =>
  wrapper.get(`[data-testid="sync-chain-connector"][data-key="${key}"] [role="switch"]`)

describe('SyncChainPanel', () => {
  beforeEach(() => {
    calls.length = 0
    editionLinkState = createEditionLinkState()
    alignmentState = createAlignmentState()
    readAlongState = createReadAlongState()
    absState = createAbsState()
    for (const mock of Object.values(toastMocks)) mock.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
    document.body.innerHTML = ''
  })

  it('shows a skeleton until the view is decided', async () => {
    const { wrapper } = await mountPanel({ open: false })

    expect(wrapper.find('[data-testid="sync-chain-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sync-chain-header-pill"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-header-live"]').text()).toBe('')
  })

  it('heads the chain with its state, politely announced, and its intro', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    const pill = wrapper.get('[data-testid="sync-chain-header-pill"]')
    expect(pill.text()).toBe('2 of 2 in sync')
    expect(wrapper.get('[data-testid="sync-chain-header-live"]').attributes('aria-live')).toBe('polite')
    expect(pill.classes()).toEqual(expect.arrayContaining(['bg-success/15', 'text-success']))
    expect(wrapper.get('[data-testid="sync-chain-intro"]').text()).toBe('Every linked edition keeps the same position.')
    expect(wrapper.text()).toContain('Position sync')
  })

  it('switches between Modify and compact, keeping focus on the toggle', async () => {
    alignedPair()
    const { wrapper } = await mountPanel({ height: 100 })
    expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('compact')

    const toggle = wrapper.get('[data-testid="sync-chain-view-toggle"]')
    expect(toggle.text()).toBe('Modify')
    await toggle.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('modify')
    expect(wrapper.get('[data-testid="sync-chain-view-toggle"]').text()).toBe('Done')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-view-toggle"]').element)
    wrapper.unmount()
  })

  it('asks before unlinking, and a cancelled confirm leaves the switch on', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    await switchOf(wrapper, 'ebook-audiobook').trigger('click')
    expect(wrapper.get('[data-testid="confirm-title"]').text()).toBe('Unlink ebook and audiobook?')

    wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
    await flushPromises()
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(switchOf(wrapper, 'ebook-audiobook').attributes('aria-checked')).toBe('true')
    expect(editionLinkState.unlink).not.toHaveBeenCalled()
  })

  it('unlinks once confirmed', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    await switchOf(wrapper, 'ebook-audiobook').trigger('click')
    wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm')
    await flushPromises()

    expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="sync-chain-card"]')).toHaveLength(1)
  })

  it('cancels a link still aligning with no confirm', async () => {
    alignedPair()
    alignmentState.status.value = 'building'
    alignmentState.builtAt.value = null
    const { wrapper } = await mountPanel()

    await switchOf(wrapper, 'ebook-audiobook').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(calls).toContain('cancelAlignment')
    expect(editionLinkState.unlink).toHaveBeenCalledWith(10)
  })

  describe('confirms', () => {
    it('unlinks the pair', async () => {
      alignedPair()
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'ebook-audiobook').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Unlink ebook and audiobook?',
        description: 'Their positions stop syncing with each other. The alignment map is kept, so linking again is instant.',
        confirmLabel: 'Unlink',
        destructive: 'true',
      })
    })

    it('says the read-along stops too when the pair has one', async () => {
      alignedPair(true)
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'readAlong-audiobook').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Unlink ebook and audiobook?',
        description:
          'Their positions stop syncing with each other. The alignment map is kept, so linking again is instant. The read-along stops syncing too and stays in its library.',
        confirmLabel: 'Unlink',
        destructive: 'true',
      })
      wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
      await flushPromises()
      expect(switchOf(wrapper, 'readAlong-audiobook').attributes('aria-checked')).toBe('true')
    })

    it('detaches the read-along', async () => {
      alignedPair(true)
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'ebook-readAlong').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Stop syncing the read-along?',
        description: 'Its position stops syncing with the other editions. The read-along book stays in its library.',
        confirmLabel: 'Stop syncing',
        destructive: 'true',
      })
      wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
      await flushPromises()
      expect(switchOf(wrapper, 'ebook-readAlong').attributes('aria-checked')).toBe('true')
    })

    it('pauses Audiobookshelf', async () => {
      alignedPair(true)
      syncingAbsMatch()
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'audiobook-abs').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Stop syncing with Audiobookshelf?',
        description: 'Listening progress stops syncing with your Audiobookshelf server. Nothing is removed there.',
        confirmLabel: 'Stop syncing',
        destructive: 'true',
      })
      wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
      await flushPromises()
      expect(switchOf(wrapper, 'audiobook-abs').attributes('aria-checked')).toBe('true')
    })
  })

  it('takes a rebuild asked for from outside to its confirm and hands the request back', async () => {
    alignedPair(true)
    const { wrapper, requested } = await mountPanel({ force: 'modify' })
    requested.value = true
    await flushPromises()

    expect(dialogText(wrapper)).toMatchObject({ title: 'Replace this read-along?', confirmLabel: 'Rebuild and replace', destructive: 'true' })
    expect(wrapper.get('[data-testid="confirm-description"]').text()).toContain('"Dune (read-along)"')
    expect(requested.value).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('modify')
  })

  it('searches in place of the card on Change', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="audiobook"] [data-testid="sync-chain-change"]').trigger('click')

    expect(wrapper.find('[data-testid="sync-chain-card"][data-edition="audiobook"]').exists()).toBe(false)
    const search = wrapper.getComponent(EditionSlotSearch)
    expect(search.props()).toMatchObject({ format: 'audiobook', cancellable: true, autofocus: true })

    search.vm.$emit('cancel')
    await flushPromises()
    expect(wrapper.find('[data-testid="sync-chain-card"][data-edition="audiobook"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('puts focus back on the card Change button when the search closes', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()
    const change = '[data-testid="sync-chain-card"][data-edition="audiobook"] [data-testid="sync-chain-change"]'

    await wrapper.get(change).trigger('click')
    expect(wrapper.find(change).exists()).toBe(false)

    wrapper.getComponent(EditionSlotSearch).vm.$emit('cancel')
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.get(change).element)
    wrapper.unmount()
  })

  it('opens the search under an Available row with no match', async () => {
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-available-row"][data-edition="audiobook"] [data-action="openSearch"]').trigger('click')

    expect(wrapper.getComponent(EditionSlotSearch).props('format')).toBe('audiobook')
    expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('')
  })

  it('names the pair change in its confirm', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="audiobook"] [data-testid="sync-chain-change"]').trigger('click')
    wrapper.getComponent(EditionSlotSearch).vm.$emit('pick', { bookId: 21, title: null, authorName: null, coverVersion: null, score: 40 })
    await flushPromises()

    expect(dialogText(wrapper)).toEqual({
      title: 'Link Untitled instead?',
      description: 'The current audiobook is unlinked and the alignment is rebuilt for the new pair.',
      confirmLabel: 'Link instead',
      destructive: 'false',
    })
  })
})
