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

type FakeTransition = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void>; skipTransition: () => void }

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
  const Host = defineComponent({
    setup() {
      panel = reactive(useSyncChainPanel(makeBook))
      return () => h(SyncChainPanel, { panel })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { stubs } })
  if (open) {
    panel.prepareView(height, force)
    await panel.handleOpen()
    await flushPromises()
  }
  return { wrapper, panel }
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

  it('switches the view inside a view transition when the browser offers one', async () => {
    alignedPair()
    const start = vi.fn<(update: () => Promise<void>) => FakeTransition>((update) => {
      const updateCallbackDone = update()
      return { updateCallbackDone, ready: updateCallbackDone, finished: updateCallbackDone, skipTransition: () => {} }
    })
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true })
    try {
      const { wrapper } = await mountPanel({ height: 100 })
      await wrapper.get('[data-testid="sync-chain-view-toggle"]').trigger('click')
      await flushPromises()

      expect(start).toHaveBeenCalledTimes(1)
      expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('modify')
      expect(document.activeElement).toBe(wrapper.get('[data-testid="sync-chain-view-toggle"]').element)
      wrapper.unmount()
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition
    }
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
    // The audiobook stays on screen as the proposed candidate, dashed, so the pair can be linked again.
    expect(wrapper.findAll('[data-testid="sync-chain-card"]')).toHaveLength(2)
    expect(switchOf(wrapper, 'ebook-audiobook').attributes('aria-checked')).toBe('false')
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

    it('says the read-along keeps syncing with the audiobook when the ebook leaves', async () => {
      alignedPair(true)
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'ebook-audiobook').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Unlink ebook and audiobook?',
        description:
          'Their positions stop syncing with each other. The alignment map is kept, so linking again is instant. The read-along keeps syncing with the audiobook.',
        confirmLabel: 'Unlink',
        destructive: 'true',
      })
      wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
      await flushPromises()
      expect(switchOf(wrapper, 'ebook-audiobook').attributes('aria-checked')).toBe('true')
    })

    it('detaches the read-along', async () => {
      alignedPair(true)
      const { wrapper } = await mountPanel()

      await switchOf(wrapper, 'readAlong-audiobook').trigger('click')

      expect(dialogText(wrapper)).toEqual({
        title: 'Stop syncing the read-along?',
        description: 'Its position stops syncing with the other editions. The read-along book stays in its library.',
        confirmLabel: 'Stop syncing',
        destructive: 'true',
      })
      wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
      await flushPromises()
      expect(switchOf(wrapper, 'readAlong-audiobook').attributes('aria-checked')).toBe('true')
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

  it('searches in place of the card on Change', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="audiobook"] [data-testid="sync-chain-change"]').trigger('click')

    expect(wrapper.find('[data-testid="sync-chain-card"][data-edition="audiobook"]').exists()).toBe(false)
    const search = wrapper.getComponent(EditionSlotSearch)
    expect(search.props()).toMatchObject({ format: 'audiobook', autofocus: true })

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

  it('searches in place of a ghost, then puts the ghost back', async () => {
    const { wrapper } = await mountPanel()
    const ghost = '[data-testid="sync-chain-ghost"][data-edition="audiobook"]'

    await wrapper.get(`${ghost} [data-action="change"]`).trigger('click')

    expect(wrapper.find(ghost).exists()).toBe(false)
    expect(wrapper.getComponent(EditionSlotSearch).props('format')).toBe('audiobook')
    expect(editionLinkState.searchCandidates).toHaveBeenCalledWith('', 10)

    wrapper.getComponent(EditionSlotSearch).vm.$emit('cancel')
    await flushPromises()
    expect(wrapper.find(ghost).exists()).toBe(true)
    wrapper.unmount()
  })

  it('picks from a ghost search without a confirm, leaving a dashed card that the switch links', async () => {
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-ghost"][data-edition="audiobook"] [data-action="change"]').trigger('click')
    wrapper.getComponent(EditionSlotSearch).vm.$emit('pick', { bookId: 21, title: 'Dune (audio)', authorName: null, coverVersion: null, score: 40 })
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sync-chain-card"][data-edition="audiobook"]').attributes('data-linked')).toBe('false')
    expect(wrapper.get('[data-testid="sync-chain-chip"]').text()).toBe('Selected')

    await switchOf(wrapper, 'ebook-audiobook').trigger('click')
    await flushPromises()
    expect(editionLinkState.linkBook).toHaveBeenCalledWith(21, 10)
    wrapper.unmount()
  })

  it('renders one straight spine with the audiobook and Audiobookshelf in a single box and the read-along last', async () => {
    alignedPair(true)
    syncingAbsMatch()
    const { wrapper } = await mountPanel()

    expect(wrapper.findAll('[data-row]').map((row) => row.attributes('data-row'))).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:readAlong-audiobook',
      'card:readAlong',
    ])
    const frames = wrapper.findAll('[data-row]').map((row) => row.attributes('data-frame'))
    expect(frames).toEqual(['spine', 'spine', 'group', 'group', 'group', 'spine', 'spine'])
    const groups = wrapper.findAll('[data-testid="sync-chain-group"]')
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect((group.element as HTMLElement).style.viewTransitionName).toBe('sync-chain-group-audio')
    expect(group.findAll('[data-row]').map((row) => row.attributes('data-row'))).toEqual(['card:audiobook', 'connector:audiobook-abs', 'card:abs'])
    expect(wrapper.html()).not.toContain('ms-[17px]')
    expect(wrapper.html()).not.toContain('border-s-2 ms-')
    wrapper.unmount()
  })

  it('draws the group box in the member chrome and its rows without card chrome', async () => {
    alignedPair(true)
    syncingAbsMatch()
    const { wrapper } = await mountPanel()

    const group = wrapper.get('[data-testid="sync-chain-group"]')
    expect(group.classes()).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-border', 'bg-card']))
    expect(group.classes()).not.toContain('border-primary')
    expect(group.classes()).not.toContain('border-dashed')
    expect(group.classes().some((c) => c.startsWith('px-') || c.startsWith('ps-') || c.startsWith('pe-'))).toBe(false)
    for (const card of group.findAll('[data-testid="sync-chain-card"]')) {
      expect(card.classes()).not.toContain('border')
      expect(card.classes()).not.toContain('rounded-xl')
      expect(card.classes()).toEqual(expect.arrayContaining(['px-2', 'py-1.5']))
    }
    expect(wrapper.get('[data-testid="sync-chain-card"][data-edition="ebook"]').classes()).toEqual(expect.arrayContaining(['border', 'rounded-xl']))
    wrapper.unmount()
  })

  it('draws the group box in the primary chrome on the audiobook page', async () => {
    editionLinkState.role.value = 'audio'
    const { wrapper } = await mountPanel()

    const group = wrapper.get('[data-testid="sync-chain-group"]')
    expect(group.classes()).toContain('border-primary')
    expect(group.get('[data-testid="sync-chain-card"]').attributes('data-this-book')).toBe('true')
    wrapper.unmount()
  })

  it('draws the group box dashed for an audiobook candidate and for a ghost', async () => {
    editionLinkState.proposed.value = { bookId: 20, title: 'Dune (audio)', authorName: null, coverVersion: null, score: 96 }
    const candidate = await mountPanel()
    expect(candidate.wrapper.get('[data-testid="sync-chain-group"]').classes()).toEqual(
      expect.arrayContaining(['border-dashed', 'border-border', 'bg-transparent']),
    )
    candidate.wrapper.unmount()

    editionLinkState.proposed.value = null
    const ghost = await mountPanel()
    const box = ghost.wrapper.get('[data-testid="sync-chain-group"]')
    expect(box.classes()).toEqual(expect.arrayContaining(['border-dashed', 'bg-transparent']))
    const row = box.get('[data-testid="sync-chain-ghost"]')
    expect(row.classes()).not.toContain('border-dashed')
    expect(row.classes()).not.toContain('rounded-xl')
    ghost.wrapper.unmount()
  })

  it('opens the audiobook and Audiobookshelf searches chrome-less inside the group box', async () => {
    alignedPair()
    syncingAbsMatch()
    const { wrapper } = await mountPanel()
    const chromeless = (classes: string[]) => {
      for (const dropped of ['rounded-xl', 'border', 'border-dashed', 'bg-card']) expect(classes).not.toContain(dropped)
    }

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="audiobook"] [data-testid="sync-chain-change"]').trigger('click')
    const audioSearch = wrapper.get('[data-testid="sync-chain-group"] [data-testid="edition-slot-search-audiobook"]')
    chromeless(audioSearch.classes())
    expect(audioSearch.classes()).toEqual(expect.arrayContaining(['px-3', 'pt-2.5', 'pb-2']))
    wrapper.getComponent(EditionSlotSearch).vm.$emit('cancel')
    await flushPromises()

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="abs"] [data-testid="sync-chain-change"]').trigger('click')
    const absSearch = wrapper.get('[data-testid="sync-chain-group"] [data-testid="sync-chain-abs-search"]')
    chromeless(absSearch.classes())
    expect(absSearch.classes()).toEqual(expect.arrayContaining(['px-3', 'pt-2.5', 'pb-2']))
    wrapper.unmount()
  })

  it('draws an unlinked read-along card dashed on the spine after the group', async () => {
    alignedPair()
    readAlongState.status.value = 'ready'
    readAlongState.outputBook.value = { id: 30, title: 'Dune (read-along)' }
    const { wrapper } = await mountPanel({ height: 100, force: 'modify' })

    expect(wrapper.get('[data-row="card:readAlong"] [data-testid="sync-chain-card"]').classes()).toEqual(
      expect.arrayContaining(['border-dashed', 'border-border']),
    )
    expect(wrapper.find('[data-testid="sync-chain-read-along-slot"]').exists()).toBe(false)
    expect(wrapper.get('[data-row="card:readAlong"]').attributes('data-frame')).toBe('spine')

    await wrapper.get('[data-testid="sync-chain-panel"] [data-testid="sync-chain-view-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-row="card:readAlong"]').classes()).not.toContain('ms-[17px]')
    wrapper.unmount()
  })

  it('puts a switch-less muted connector above the un-generated slot and a switch on the generated one', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()

    const connector = wrapper.get('[data-row="connector:readAlong-audiobook"]')
    expect(connector.find('[role="switch"]').exists()).toBe(false)
    expect(connector.attributes('data-frame')).toBe('spine')
    expect(
      wrapper
        .findAll('[data-row]')
        .map((row) => row.attributes('data-row'))
        .slice(-2),
    ).toEqual(['connector:readAlong-audiobook', 'slot:readAlong'])
    wrapper.unmount()
  })

  it('opens the generate options in the bottom slot and builds only from their button', async () => {
    alignedPair()
    const { wrapper } = await mountPanel()
    const slot = '[data-testid="sync-chain-read-along-slot"]'

    expect(wrapper.find('[data-row="slot:readAlong"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="read-along-build-options"]').exists()).toBe(false)

    await wrapper.get(`${slot} [data-action="openGenerate"]`).trigger('click')
    expect(wrapper.find('[data-testid="read-along-build-options"]').exists()).toBe(true)
    expect(wrapper.find(`${slot} [data-action="openGenerate"]`).exists()).toBe(false)
    expect(readAlongState.build).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="read-along-generate"]').trigger('click')
    await flushPromises()
    expect(readAlongState.build).toHaveBeenCalledWith(10, {})
    expect(wrapper.find('[data-testid="read-along-build-options"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('builds an unlinked pair with the counterpart through the same options', async () => {
    editionLinkState.proposed.value = { bookId: 20, title: 'Dune (audio)', authorName: null, coverVersion: null, score: 96 }
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-read-along-slot"] [data-action="openGenerate"]').trigger('click')
    await wrapper.get('[data-testid="read-along-generate"]').trigger('click')
    await flushPromises()

    expect(readAlongState.build).toHaveBeenCalledWith(10, { counterpartId: 20 })
    wrapper.unmount()
  })

  it('keeps ghosts dashed with text-link Search in compact, and the slot Generate locked until an audiobook is linked', async () => {
    const { wrapper } = await mountPanel({ height: 100 })

    expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('compact')
    const ghost = wrapper.get('[data-testid="sync-chain-ghost"][data-edition="audiobook"]')
    expect(wrapper.get('[data-testid="sync-chain-group"]').classes()).toContain('border-dashed')
    expect(ghost.get('button').text()).toBe('Search')
    const slot = wrapper.get('[data-testid="sync-chain-read-along-slot"]')
    expect(slot.get('[data-action="openGenerate"]').attributes('disabled')).toBeDefined()
    expect(slot.text()).toContain('Pick an audiobook first')
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
