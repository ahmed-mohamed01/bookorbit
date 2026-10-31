import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import type { BookDetail, ReadAloudProgressSync } from '@bookorbit/types'
import {
  calls,
  createAbsState,
  createAlignmentState,
  createReadAloudPreferencesState,
  createReadAloudState,
} from '@/features/book/composables/__tests__/sync-chain-panel-mocks'
import { makeCapability, makeJob } from '@/features/read-aloud/__tests__/fixtures'
import { useSyncChainPanel, type SyncChainPanelView } from '@/features/book/composables/useSyncChainPanel'
import type { ChainViewMode } from '@/features/book/lib/sync-chain'
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
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission, isDemoRestrictedAccount: { value: false } }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn<(to: unknown) => Promise<void>>() }) }))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 1 }) }) }))
const apiMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/lib/api', () => ({ api: apiMock }))

let alignmentState = createAlignmentState()
let absState = createAbsState()
let readAloudState = createReadAloudState()
const preferencesState = createReadAloudPreferencesState()

vi.mock('@/features/book/composables/useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('@/features/book/composables/useAudiobookshelfSyncLink', () => ({ useAudiobookshelfSyncLink: () => absState }))
vi.mock('@/features/read-aloud/composables/useReadAloud', () => ({ useReadAloud: () => readAloudState }))
vi.mock('@/features/read-aloud/composables/useReadAloudPreferences', () => ({ useReadAloudPreferences: () => preferencesState }))

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

function readAloudSync(overrides: Partial<ReadAloudProgressSync> = {}): ReadAloudProgressSync {
  return {
    mode: 'auto',
    state: 'enabled',
    unavailableReason: null,
    overlayFileId: 3,
    audioDurationSeconds: 3600,
    overlayDurationSeconds: 3600,
    durationDifferenceSeconds: 0,
    durationDifferenceRatio: 0,
    koreaderDownloadAvailable: false,
    ...overrides,
  }
}

type Shape = 'pair' | 'pairWithReadAlong' | 'ebookAndReadAlong'

const READ_ALOUD_BY_SHAPE: Record<Shape, () => ReadAloudProgressSync> = {
  pair: () => readAloudSync({ state: 'unavailable', unavailableReason: 'no_media_overlay_epub' }),
  pairWithReadAlong: () => readAloudSync(),
  ebookAndReadAlong: () => readAloudSync({ state: 'unavailable', unavailableReason: 'no_audio_files', audioDurationSeconds: null }),
}

function makeBook(shape: Shape = 'pair'): BookDetail {
  const epub = { id: 1, format: 'epub', role: 'content', filename: 'Dune.epub', absolutePath: '/b/Dune.epub', sizeBytes: 1024 }
  const audio = { id: 2, format: 'm4b', role: 'content', filename: 'Dune.m4b', absolutePath: '/b/Dune.m4b', sizeBytes: 1024 }
  const readAlong = { ...epub, id: 3, filename: 'Dune (read-along).epub', mediaOverlay: { available: true } }
  const files = shape === 'pair' ? [epub, audio] : shape === 'pairWithReadAlong' ? [epub, audio, readAlong] : [epub, readAlong]
  return {
    id: 10,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    formatPriority: [],
    files,
    readAloudSync: READ_ALOUD_BY_SHAPE[shape](),
  } as unknown as BookDetail
}

interface MountOptions {
  height?: number
  force?: ChainViewMode
  open?: boolean
  shape?: Shape
  canCreateReadAloud?: boolean
}

async function mountPanel({ height = 10_000, force, open = true, shape = 'pair', canCreateReadAloud = false }: MountOptions = {}) {
  if (canCreateReadAloud) readAloudState.capability.value = makeCapability()
  let panel!: SyncChainPanelView
  const book = makeBook(shape)
  const Host = defineComponent({
    setup() {
      panel = reactive(useSyncChainPanel(() => book))
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

function aligned() {
  alignmentState.status.value = 'ready'
  alignmentState.builtAt.value = '2026-10-01T00:00:00.000Z'
}

function syncingAbsMatch() {
  absState.link.value = {
    audioBookId: 10,
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
    alignmentState = createAlignmentState()
    absState = createAbsState()
    readAloudState = createReadAloudState()
    for (const mock of Object.values(toastMocks)) mock.mockReset()
    apiMock.mockReset()
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
    aligned()
    const { wrapper } = await mountPanel()

    const pill = wrapper.get('[data-testid="sync-chain-header-pill"]')
    expect(pill.text()).toBe('2 of 2 in sync')
    expect(wrapper.get('[data-testid="sync-chain-header-live"]').attributes('aria-live')).toBe('polite')
    expect(pill.classes()).toEqual(expect.arrayContaining(['bg-success/15', 'text-success']))
    expect(wrapper.get('[data-testid="sync-chain-intro"]').text()).toBe('Synced files keep the same position as you switch between them.')
    expect(wrapper.text()).toContain('Position sync')
  })

  it('switches between Modify and compact, keeping focus on the toggle', async () => {
    aligned()
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
    aligned()
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

  describe('confirms', () => {
    it('pauses Audiobookshelf', async () => {
      aligned()
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

  it('turns read-aloud sync off straight from its switch, with no confirm', async () => {
    aligned()
    const book = makeBook('pairWithReadAlong')
    apiMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...book, readAloudSync: readAloudSync({ mode: 'disabled', state: 'disabled' }) }),
    } as Response)
    const { wrapper } = await mountPanel({ shape: 'pairWithReadAlong' })

    await switchOf(wrapper, 'readAlong-audiobook').trigger('click')
    await flushPromises()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/books/10/read-aloud-sync', expect.objectContaining({ method: 'PATCH' }))
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(switchOf(wrapper, 'readAlong-audiobook').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('offers Create read-aloud and Modify in the slot after the audio box when the book is eligible', async () => {
    const { wrapper } = await mountPanel({ canCreateReadAloud: true })

    const rows = wrapper.findAll('[data-row]').map((row) => row.attributes('data-row'))
    expect(rows.slice(-2)).toEqual(['connector:readAlong-audiobook', 'slot:readAlong'])
    const slot = wrapper.get('[data-testid="sync-chain-read-aloud-slot"]')
    expect(slot.get('[data-action="createReadAloud"]').text()).toBe('Create read-aloud')
    expect(slot.get('[data-action="modifyReadAloud"]').text()).toBe('Modify')
    wrapper.unmount()
  })

  it('follows a running read-aloud job with its stepper', async () => {
    readAloudState.job.value = makeJob({ status: 'processing', stage: 'aligning', progress: 64 })
    const { wrapper } = await mountPanel()

    const slot = wrapper.get('[data-testid="sync-chain-read-aloud-slot"]')
    expect(slot.attributes('data-variant')).toBe('processing')
    expect(slot.get('[data-testid="read-aloud-percent"]').text()).toBe('64%')
    expect(slot.find('[data-action="cancelReadAloud"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="sync-chain-header-pill"]').text()).toBe('Not syncing')
    wrapper.unmount()
  })

  it('joins an ebook and a read-along without an audiobook, and turns their EPUB copies sync off from its switch', async () => {
    const book = makeBook('ebookAndReadAlong')
    apiMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...book, readAloudSync: readAloudSync({ mode: 'disabled', state: 'disabled' }) }),
    } as Response)
    const { wrapper } = await mountPanel({ shape: 'ebookAndReadAlong' })

    const rows = wrapper.findAll('[data-row]')
    expect(rows.map((row) => row.attributes('data-row'))).toEqual(['card:ebook', 'connector:ebook-readAlong', 'card:readAlong'])
    expect(rows.some((row) => row.classes().includes('mt-1.5'))).toBe(false)
    expect(wrapper.get('[data-key="ebook-readAlong"] [data-testid="sync-chain-qualifier"]').text()).toBe('EPUB copies only')
    expect(switchOf(wrapper, 'ebook-readAlong').attributes('aria-checked')).toBe('true')

    await switchOf(wrapper, 'ebook-readAlong').trigger('click')
    await flushPromises()

    expect(apiMock).toHaveBeenCalledWith(
      '/api/v1/books/10/read-aloud-sync',
      expect.objectContaining({ method: 'PATCH', body: '{"mode":"disabled"}' }),
    )
    expect(switchOf(wrapper, 'ebook-readAlong').attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('renders one straight spine with the read-along between the ebook and the audio box', async () => {
    aligned()
    syncingAbsMatch()
    const { wrapper } = await mountPanel({ shape: 'pairWithReadAlong' })

    expect(wrapper.findAll('[data-row]').map((row) => row.attributes('data-row'))).toEqual([
      'card:ebook',
      'connector:ebook-readAlong',
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
    ])
    const frames = wrapper.findAll('[data-row]').map((row) => row.attributes('data-frame'))
    expect(frames).toEqual(['spine', 'spine', 'spine', 'spine', 'group', 'group', 'group'])
    const groups = wrapper.findAll('[data-testid="sync-chain-group"]')
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect((group.element as HTMLElement).style.viewTransitionName).toBe('sync-chain-group-audio')
    expect(group.findAll('[data-row]').map((row) => row.attributes('data-row'))).toEqual(['card:audiobook', 'connector:audiobook-abs', 'card:abs'])
    expect(wrapper.html()).not.toContain('ms-[17px]')
    expect(wrapper.html()).not.toContain('border-s-2 ms-')
    wrapper.unmount()
  })

  it('draws the group box in the card chrome and its rows without card chrome', async () => {
    aligned()
    syncingAbsMatch()
    const { wrapper } = await mountPanel({ shape: 'pairWithReadAlong' })

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

  it('opens the Audiobookshelf search chrome-less inside the group box', async () => {
    aligned()
    syncingAbsMatch()
    const { wrapper } = await mountPanel()

    await wrapper.get('[data-testid="sync-chain-card"][data-edition="abs"] [data-testid="sync-chain-change"]').trigger('click')
    const absSearch = wrapper.get('[data-testid="sync-chain-group"] [data-testid="sync-chain-abs-search"]')
    for (const dropped of ['rounded-xl', 'border', 'border-dashed', 'bg-card']) expect(absSearch.classes()).not.toContain(dropped)
    expect(absSearch.classes()).toEqual(expect.arrayContaining(['px-3', 'pt-2.5', 'pb-2']))
    wrapper.unmount()
  })

  it('keeps the read-aloud slot dashed with its full actions in compact', async () => {
    const { wrapper } = await mountPanel({ height: 100, canCreateReadAloud: true })

    expect(wrapper.get('[data-testid="sync-chain-panel"]').attributes('data-view')).toBe('compact')
    const slot = wrapper.get('[data-testid="sync-chain-read-aloud-slot"]')
    expect(slot.classes()).toContain('border-dashed')
    expect(slot.findAll('button').map((button) => button.text())).toEqual(['Create read-aloud', 'Modify'])
  })
})
