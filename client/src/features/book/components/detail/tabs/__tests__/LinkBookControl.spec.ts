import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createReadAloudPreferencesState, createReadAloudState } from '@/features/book/composables/__tests__/sync-chain-panel-mocks'
import { makeCapability } from '@/features/read-aloud/__tests__/fixtures'
import LinkBookControl from '../LinkBookControl.vue'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(...args: unknown[]) => boolean>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission, isDemoRestrictedAccount: { value: false } }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn<(to: unknown) => Promise<void>>() }) }))
vi.mock('@/features/auth/composables/useAuth', async () => {
  const { ref } = await import('vue')
  return { useAuth: () => ({ user: ref({ id: 1 }) }) }
})

let readAloudState = createReadAloudState()
const preferencesState = createReadAloudPreferencesState()
vi.mock('@/features/read-aloud/composables/useReadAloud', () => ({ useReadAloud: () => readAloudState }))
vi.mock('@/features/read-aloud/composables/useReadAloudPreferences', () => ({ useReadAloudPreferences: () => preferencesState }))

const absSyncLinkMocks = vi.hoisted(() => ({
  audioBookIds: [] as (number | null)[],
  configured: false,
  refreshLive: vi.fn<() => void>(),
  applyLive: vi.fn<(live: unknown) => void>(),
}))
vi.mock('@/features/book/composables/useAudiobookshelfSyncLink', async () => {
  const { ref, watch } = await import('vue')
  return {
    useAudiobookshelfSyncLink: (audioBookId: import('vue').Ref<number | null>) => {
      watch(audioBookId, (id) => absSyncLinkMocks.audioBookIds.push(id), { immediate: true })
      return {
        link: ref(null),
        live: ref(null),
        checking: ref(false),
        configured: ref(absSyncLinkMocks.configured),
        loadConfigured: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        refreshLive: absSyncLinkMocks.refreshLive,
        applyLive: absSyncLinkMocks.applyLive,
        reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }
    },
  }
})

function createAlignmentState() {
  return {
    status: ref<string>('none'),
    samplesDone: ref<number | null>(null),
    samplesTotal: ref<number | null>(null),
    builtAt: ref<string | null>(null),
    stale: ref(false),
    mutating: ref(false),
    error: ref<string | null>(null),
    buildError: ref<string | null>(null),
    buildBlocked: ref<string | null>(null),
    fetchStatus: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    build: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    cancel: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  }
}

let mockAlignment = createAlignmentState()

vi.mock('@/features/book/composables/useReadingAlignment', () => ({
  useReadingAlignment: () => mockAlignment,
}))

const stubs = {
  Popover: { name: 'Popover', props: ['open'], emits: ['update:open'], template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>' },
  PopoverContent: { name: 'PopoverContent', template: '<div><slot /></div>' },
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
  SyncChainPanel: {
    name: 'SyncChainPanel',
    props: ['panel'],
    template: '<div data-testid="sync-chain-panel" />',
  },
  ReadAloudDialog: {
    name: 'ReadAloudDialog',
    props: ['open', 'capability', 'defaultLanguage', 'initial', 'busy', 'error'],
    emits: ['close', 'create'],
    template: '<div data-testid="read-aloud-dialog" :data-open="open" />',
  },
}

function makeBook(overrides = {}) {
  return {
    id: 10,
    libraryId: 1,
    libraryName: 'My Library',
    status: 'ok',
    folderPath: '/books',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    title: 'Test Book',
    subtitle: null,
    description: null,
    isbn10: null,
    isbn13: null,
    publisher: null,
    publishedDate: null,
    publishedYear: null,
    language: null,
    pageCount: null,
    seriesName: null,
    seriesIndex: null,
    rating: null,
    personalNote: null,
    personalNoteUpdatedAt: null,
    communityRatings: [],
    coverSource: null,
    hardcoverEditionId: null,
    providerIds: {},
    authors: [],
    genres: [],
    tags: [],
    files: [
      {
        id: 1,
        format: 'epub',
        role: 'content',
        sizeBytes: 100,
        absolutePath: '/b.epub',
        createdAt: '2026-01-01',
        filename: 'b.epub',
        durationSeconds: null,
      },
    ],
    lastWrittenAt: null,
    metadataScore: null,
    readStatus: null,
    audioMetadata: null,
    readAloudSync: {
      mode: 'auto' as const,
      state: 'unavailable' as const,
      unavailableReason: 'no_media_overlay_epub' as const,
      overlayFileId: null,
      audioDurationSeconds: null,
      overlayDurationSeconds: null,
      durationDifferenceSeconds: null,
      durationDifferenceRatio: null,
      koreaderDownloadAvailable: false,
    },
    formatPriority: [],
    comicMetadata: null,
    customMetadata: [],
    lockedFields: [],
    coverMedia: [],
    covers: { ebook: null, audio: null },
    coverVersion: 'legacy:2024-01-01T00:00:00.000Z',
    collections: [],
    ...overrides,
  }
}

function mountControl(overrides = {}) {
  return mount(LinkBookControl, { props: { book: makeBook(overrides) }, global: { stubs } })
}

async function openPopover(wrapper: ReturnType<typeof mountControl>) {
  await wrapper.findComponent({ name: 'Popover' }).vm.$emit('update:open', true)
  await flushPromises()
}

const audioFile = {
  id: 1,
  format: 'm4b',
  role: 'content',
  sizeBytes: 1,
  absolutePath: '/a.m4b',
  createdAt: '2026-01-01',
  filename: 'a.m4b',
  durationSeconds: null,
}

describe('LinkBookControl', () => {
  beforeEach(() => {
    mockAlignment = createAlignmentState()
    readAloudState = createReadAloudState()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    toastMocks.info.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
    absSyncLinkMocks.configured = false
  })

  it('names the popover for view transitions with a class, not an inline style', async () => {
    const wrapper = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })
    await openPopover(wrapper)

    const content = wrapper.findComponent({ name: 'PopoverContent' })
    expect(content.classes()).toContain('[view-transition-name:sync-chain-popover]')
    expect(content.attributes('style')).toBeUndefined()
  })

  it('renders only when the book has two sides to sync', () => {
    const epub = makeBook().files[0]
    const readAlong = { ...epub, id: 3, filename: 'b.readaloud.epub', mediaOverlay: { available: true } }
    expect(
      mountControl({ files: [epub, { ...audioFile, id: 2 }] })
        .find('button')
        .exists(),
    ).toBe(true)
    expect(
      mountControl({ files: [readAlong, { ...audioFile, id: 2 }] })
        .find('button')
        .exists(),
    ).toBe(true)
    expect(
      mountControl({ files: [epub, readAlong] })
        .find('button')
        .exists(),
    ).toBe(true)
    expect(mountControl().find('button').exists()).toBe(false)
    expect(
      mountControl({ files: [audioFile] })
        .find('button')
        .exists(),
    ).toBe(false)
    expect(mountControl({ files: [] }).find('button').exists()).toBe(false)
  })

  it('renders for an audio-only book when Audiobookshelf is set up and the reader may sync it', () => {
    absSyncLinkMocks.configured = true
    expect(
      mountControl({ files: [audioFile] })
        .find('button')
        .exists(),
    ).toBe(true)
    permissionMocks.hasPermission.mockReturnValue(false)
    expect(
      mountControl({ files: [audioFile] })
        .find('button')
        .exists(),
    ).toBe(false)
  })

  it('stays hidden for a single-file book even when a read-aloud could be created', () => {
    readAloudState.capability.value = makeCapability()
    const wrapper = mountControl()
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('reads this book’s alignment status on mount when it holds both, so the trigger is accurate before opening', async () => {
    const wrapper = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })
    await flushPromises()

    expect(wrapper.find('button').attributes('aria-label')).toBe('Position sync')
    expect(mockAlignment.fetchStatus).toHaveBeenCalledWith(10)
  })

  it.each([
    ['none', '', 'Position sync: Not syncing'],
    ['building', 'text-info', 'Position sync: Aligning'],
    ['ready', 'text-success', 'Position sync: 2 of 2 in sync'],
    ['failed', 'text-destructive', 'Position sync: Needs attention'],
  ] as const)('narrates alignment %s on the trigger', (alignment, tint, title) => {
    mockAlignment.status.value = alignment
    const wrapper = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })

    const classes = wrapper.find('button').find('svg').classes()
    expect(tint === '' || classes.includes(tint)).toBe(true)
    expect(wrapper.find('button').attributes('title')).toBe(title)
  })

  it('looks the Audiobookshelf link up for this book when it holds audio, and refreshes it on open', async () => {
    absSyncLinkMocks.audioBookIds.length = 0
    absSyncLinkMocks.refreshLive.mockClear()
    absSyncLinkMocks.configured = true
    const wrapper = mountControl({ files: [audioFile] })
    await flushPromises()

    expect(absSyncLinkMocks.audioBookIds.at(-1)).toBe(10)
    expect(absSyncLinkMocks.refreshLive).not.toHaveBeenCalled()

    await openPopover(wrapper)
    expect(absSyncLinkMocks.refreshLive).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="sync-chain-panel"]').exists()).toBe(true)
  })

  it('opens upstream’s read-aloud dialog outside the popover from Modify, and creates from it', async () => {
    readAloudState.capability.value = makeCapability()
    const wrapper = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }], language: 'en' })
    await openPopover(wrapper)

    const dialog = () => wrapper.findComponent({ name: 'ReadAloudDialog' })
    expect(dialog().props()).toMatchObject({ open: false, initial: null, defaultLanguage: 'en', busy: false, error: null })
    expect(wrapper.findComponent({ name: 'PopoverContent' }).findComponent({ name: 'ReadAloudDialog' }).exists()).toBe(false)

    wrapper.findComponent({ name: 'SyncChainPanel' }).props('panel').runAction('modifyReadAloud')
    await flushPromises()
    expect(dialog().props('open')).toBe(true)
    expect(wrapper.findComponent({ name: 'Popover' }).props('open')).toBe(true)

    const input = { epubFileId: 101, audioFileIds: [102], language: 'en', granularity: 'sentence' }
    dialog().vm.$emit('create', input)
    await flushPromises()
    expect(readAloudState.create).toHaveBeenCalledWith(input)
    expect(dialog().props('open')).toBe(false)
  })

  it('closes the dialog on request', async () => {
    readAloudState.capability.value = makeCapability()
    const wrapper = mountControl({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })
    await openPopover(wrapper)
    wrapper.findComponent({ name: 'SyncChainPanel' }).props('panel').runAction('modifyReadAloud')
    await flushPromises()
    wrapper.findComponent({ name: 'ReadAloudDialog' }).vm.$emit('close')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ReadAloudDialog' }).props('open')).toBe(false)
  })

  describe('view on open', () => {
    let rectSpy: ReturnType<typeof vi.spyOn> | null = null
    const innerHeight = window.innerHeight

    afterEach(() => {
      rectSpy?.mockRestore()
      rectSpy = null
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
    })

    function placeTrigger(top: number, bottom: number, viewport: number) {
      rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top, bottom } as DOMRect)
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport })
    }

    function alignedPair() {
      mockAlignment.status.value = 'ready'
      mockAlignment.builtAt.value = '2026-10-01T00:00:00.000Z'
    }

    const pair = () => ({ files: [makeBook().files[0], { ...audioFile, id: 2 }] })

    it('opens compact when the Modify chain would not fit the space beside the trigger', async () => {
      alignedPair()
      placeTrigger(10, 40, 200)
      const wrapper = mountControl(pair())
      await openPopover(wrapper)

      expect(wrapper.findComponent({ name: 'SyncChainPanel' }).props('panel').viewMode).toBe('compact')
    })

    it('opens in Modify when it fits', async () => {
      alignedPair()
      placeTrigger(10, 40, 2000)
      const wrapper = mountControl(pair())
      await openPopover(wrapper)

      expect(wrapper.findComponent({ name: 'SyncChainPanel' }).props('panel').viewMode).toBe('modify')
    })
  })
})
