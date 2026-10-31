import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type { AudiobookshelfBookSyncLink, BookDetail, ReadAloudProgressSync } from '@bookorbit/types'
import type { ChainCardRow, ChainConnectorRow, ConnectorKey } from '@/features/book/lib/sync-chain'
import type { EditionProgress } from '@/features/book/components/detail/details/BookEditionsCard.vue'
import { useSyncChainPanel, type SyncChainPanelOptions } from '../useSyncChainPanel'
import { makeCapability, makeJob } from '@/features/read-aloud/__tests__/fixtures'
import { calls, createAbsState, createAlignmentState, createReadAloudPreferencesState, createReadAloudState } from './sync-chain-panel-mocks'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
}))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>(), demo: { value: false } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission, isDemoRestrictedAccount: permissionMocks.demo }),
}))

const routerMocks = vi.hoisted(() => ({ push: vi.fn<(to: unknown) => Promise<void>>() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerMocks.push }) }))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 1 }) }) }))

const apiMocks = vi.hoisted(() => ({ api: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>() }))
vi.mock('@/lib/api', () => ({ api: apiMocks.api }))

const absApiMocks = vi.hoisted(() => ({
  reconcile: vi.fn<(id: string, direction: string) => Promise<unknown>>(),
  exclusion: vi.fn<(id: string, excluded: boolean) => Promise<unknown>>(),
}))
vi.mock('@/features/audiobookshelf/api/audiobookshelf.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/audiobookshelf/api/audiobookshelf.api')>()),
  reconcileAudiobookshelfPosition: absApiMocks.reconcile,
  updateAudiobookshelfBookExclusion: absApiMocks.exclusion,
}))

let alignmentState = createAlignmentState()
let absState = createAbsState()
let readAloudState = createReadAloudState()
let preferencesState = createReadAloudPreferencesState()

vi.mock('@/features/read-aloud/composables/useReadAloud', () => ({
  useReadAloud: (options: import('@/features/read-aloud/composables/useReadAloud').UseReadAloudOptions) => {
    readAloudState.options = options
    return readAloudState
  },
}))
vi.mock('@/features/read-aloud/composables/useReadAloudPreferences', () => ({ useReadAloudPreferences: () => preferencesState }))

vi.mock('../useReadingAlignment', () => ({ useReadingAlignment: () => alignmentState }))
vi.mock('../useAudiobookshelfSyncLink', async () => {
  const { watch } = await import('vue')
  return {
    useAudiobookshelfSyncLink: (audioBookId: import('vue').Ref<number | null>) => {
      watch(audioBookId, (id) => absState.audioBookIds.push(id), { immediate: true })
      return absState
    },
  }
})

function sync(overrides: Partial<ReadAloudProgressSync> = {}): ReadAloudProgressSync {
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

type FileSpec = { id: number; format: string; filename: string; readAlong?: boolean }

const EPUB: FileSpec = { id: 1, format: 'epub', filename: 'Dune.epub' }
const M4B: FileSpec = { id: 2, format: 'm4b', filename: 'Dune.m4b' }
const READ_ALONG: FileSpec = { id: 3, format: 'epub', filename: 'Dune (read-along).epub', readAlong: true }

function makeBook(
  files: FileSpec[] = [EPUB, M4B],
  readAloudSync: ReadAloudProgressSync = sync({ state: 'unavailable', unavailableReason: 'no_media_overlay_epub' }),
) {
  return {
    id: 10,
    title: 'Dune',
    authors: [{ id: 1, name: 'Frank Herbert', sortName: null }],
    coverVersion: 'v1',
    formatPriority: [],
    files: files.map((file) => ({
      id: file.id,
      format: file.format,
      role: 'content',
      filename: file.filename,
      absolutePath: `/books/Dune/${file.filename}`,
      sizeBytes: 2048,
      mediaOverlay: file.readAlong ? { available: true } : null,
    })),
    readAloudSync,
  } as unknown as BookDetail
}

function mountPanel(book: BookDetail = makeBook(), options: SyncChainPanelOptions = {}) {
  let panel!: ReturnType<typeof useSyncChainPanel>
  mount(
    defineComponent({
      setup() {
        panel = useSyncChainPanel(() => book, options)
        return () => null
      },
    }),
  )
  return panel
}

type Panel = ReturnType<typeof useSyncChainPanel>

function connector(panel: Panel, key: ConnectorKey): ChainConnectorRow {
  const row = panel.chain.value.rows.find((r): r is ChainConnectorRow => r.kind === 'connector' && r.key === key)
  if (!row) throw new Error(`no ${key} connector`)
  return row
}

function card(panel: Panel, id: string): ChainCardRow {
  const row = panel.chain.value.rows.find((r): r is ChainCardRow => r.kind === 'card' && r.id === id)
  if (!row) throw new Error(`no ${id}`)
  return row
}

const rowIds = (panel: Panel) => panel.chain.value.rows.map((row) => row.id)

function absMatch(overrides: Partial<AudiobookshelfBookSyncLink> = {}) {
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
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

beforeEach(() => {
  calls.length = 0
  alignmentState = createAlignmentState()
  absState = createAbsState()
  readAloudState = createReadAloudState()
  preferencesState = createReadAloudPreferencesState()
  routerMocks.push.mockReset().mockResolvedValue(undefined)
  permissionMocks.demo.value = false
  toastMocks.success.mockReset()
  toastMocks.error.mockReset()
  apiMocks.api.mockReset()
  permissionMocks.hasPermission.mockReset().mockReturnValue(true)
})

describe('useSyncChainPanel rows', () => {
  it('builds the rows from the book’s own files', () => {
    const panel = mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync()))
    expect(rowIds(panel)).toEqual([
      'card:ebook',
      'connector:ebook-readAlong',
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
    ])
    expect(card(panel, 'card:ebook')).toMatchObject({ title: 'Dune', cover: { kind: 'book', bookId: 10, coverVersion: 'v1' } })
    expect(card(panel, 'card:readAlong').title).toBe('Dune (read-along)')
  })

  it.each([
    ['EPUB + audio', [EPUB, M4B]],
    ['read-along + audio', [READ_ALONG, M4B]],
    ['read-along + plain EPUB', [EPUB, READ_ALONG]],
  ])('is eligible for %s', (_label, files) => {
    absState.configured.value = false
    expect(mountPanel(makeBook(files)).isEligible.value).toBe(true)
  })

  it('is not eligible for a single EPUB, or a book with neither an EPUB nor audio', () => {
    expect(mountPanel(makeBook([EPUB])).isEligible.value).toBe(false)
    expect(mountPanel(makeBook([{ id: 4, format: 'pdf', filename: 'Dune.pdf' }])).isEligible.value).toBe(false)
  })

  it('is eligible for audio alone only when Audiobookshelf applies to it', () => {
    expect(mountPanel(makeBook([M4B])).isEligible.value).toBe(true)
    absState.configured.value = false
    expect(mountPanel(makeBook([M4B])).isEligible.value).toBe(false)
    absState.configured.value = true
    permissionMocks.hasPermission.mockImplementation((name) => name !== 'audiobookshelf_sync')
    expect(mountPanel(makeBook([M4B])).isEligible.value).toBe(false)
  })

  it('needs two sides even when a read-aloud could be created', () => {
    readAloudState.capability.value = makeCapability()
    expect(mountPanel(makeBook([EPUB])).isEligible.value).toBe(false)
  })

  it('reads each row’s progress from the book page by format key', () => {
    const progress: EditionProgress[] = [
      { key: 'epub', percentage: 26, finished: false },
      { key: 'm4b', percentage: 63, finished: false },
    ]
    const panel = mountPanel(makeBook(), { progress: () => progress })
    expect(card(panel, 'card:ebook').progress).toBe(26)
    expect(card(panel, 'card:audiobook').progress).toBe(63)
  })

  it('matches Audiobookshelf to this book only while it holds audio', () => {
    mountPanel(makeBook([EPUB]))
    expect(absState.audioBookIds).toEqual([null])
    absState = createAbsState()
    mountPanel(makeBook())
    expect(absState.audioBookIds).toEqual([10])
  })
})

describe('alignment', () => {
  it('reads the status of this book up front only when it holds both an EPUB and audio and no read-along', async () => {
    await mountPanel(makeBook([EPUB])).loadInitial()
    await mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync())).loadInitial()
    expect(alignmentState.fetchStatus).not.toHaveBeenCalled()
    await mountPanel(makeBook()).loadInitial()
    expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
  })

  it('reads whether Audiobookshelf is set up up front only for a book with audio', async () => {
    await mountPanel(makeBook([EPUB])).loadInitial()
    expect(absState.loadConfigured).not.toHaveBeenCalled()
    await mountPanel(makeBook([M4B])).loadInitial()
    expect(absState.loadConfigured).toHaveBeenCalledOnce()
  })

  it('aligns, rebuilds and cancels this book', async () => {
    alignmentState.status.value = 'none'
    const panel = mountPanel()
    panel.runAction('alignNow')
    panel.runAction('rebuildAlignment')
    panel.runAction('cancelAlignment')
    await flushPromises()
    expect(alignmentState.build.mock.calls).toEqual([
      [10, false],
      [10, true],
    ])
    expect(alignmentState.cancel).toHaveBeenCalledWith(10)
  })

  it('reports a build request that failed', async () => {
    alignmentState.build.mockImplementation(async () => {
      alignmentState.error.value = 'nope'
    })
    mountPanel().runAction('alignNow')
    await flushPromises()
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to start alignment build.')
  })

  it('reports a cancel the server refused', async () => {
    alignmentState.cancel.mockResolvedValue(false)
    mountPanel().runAction('cancelAlignment')
    await flushPromises()
    expect(toastMocks.error).toHaveBeenCalledWith("The position sync build couldn't be cancelled and keeps running.")
  })
})

describe('read-aloud sync', () => {
  it('turns the read-along switch off through upstream’s endpoint and hands the saved book back', async () => {
    const updated = { ...makeBook([EPUB, M4B, READ_ALONG], sync({ mode: 'disabled', state: 'disabled' })) }
    apiMocks.api.mockResolvedValue(jsonResponse(updated))
    const onSaved = vi.fn<(book: BookDetail) => void>()
    const panel = mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync()), { onSaved })

    panel.switchConnector('readAlong-audiobook', false)
    await flushPromises()

    expect(apiMocks.api).toHaveBeenCalledWith('/api/v1/books/10/read-aloud-sync', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'disabled' }),
    })
    expect(onSaved).toHaveBeenCalledWith(updated)
    expect(connector(panel, 'readAlong-audiobook').switch?.on).toBe(false)
  })

  it('turns it back on', async () => {
    apiMocks.api.mockResolvedValue(jsonResponse(makeBook([EPUB, M4B, READ_ALONG], sync())))
    const panel = mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync({ mode: 'disabled', state: 'disabled' })))
    panel.switchConnector('readAlong-audiobook', true)
    await flushPromises()
    expect(JSON.parse(apiMocks.api.mock.calls[0]![1]!.body as string)).toEqual({ mode: 'auto' })
  })

  it('keeps the mode and says so when the save fails', async () => {
    apiMocks.api.mockResolvedValue(jsonResponse(null, false))
    const panel = mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync()))
    panel.switchConnector('readAlong-audiobook', false)
    await flushPromises()
    expect(toastMocks.error).toHaveBeenCalledWith('Could not update read-aloud progress sync.')
    expect(connector(panel, 'readAlong-audiobook').switch?.on).toBe(true)
  })

  it('formats a duration mismatch with upstream’s duration copy', () => {
    const panel = mountPanel(
      makeBook(
        [EPUB, M4B, READ_ALONG],
        sync({ state: 'unavailable', unavailableReason: 'duration_mismatch', audioDurationSeconds: 7260, overlayDurationSeconds: 600 }),
      ),
    )
    expect(connector(panel, 'readAlong-audiobook').note).toEqual({
      key: 'book.detail.details.readAloudSync.reason.durationMismatch',
      params: { audio: '2h 1m', overlay: '10m' },
    })
  })
})

describe('read-aloud slot', () => {
  const slot = (panel: Panel) => panel.chain.value.rows.find((row) => row.kind === 'readAloudSlot')

  function offerable(book: BookDetail = makeBook()) {
    readAloudState.capability.value = makeCapability()
    return mountPanel({ ...book, language: 'en' } as BookDetail)
  }

  it('runs upstream’s generator only for a book with an EPUB and audio and no read-along, with the permission', () => {
    mountPanel(makeBook())
    expect(readAloudState.options?.enabled.value).toBe(true)
    expect(readAloudState.options?.bookId.value).toBe(10)
    expect(readAloudState.options?.fileIds.value).toEqual([1, 2])
    expect(readAloudState.options?.viewerId.value).toBe(1)
    mountPanel(makeBook([EPUB, M4B, READ_ALONG], sync()))
    expect(readAloudState.options?.enabled.value).toBe(false)
    mountPanel(makeBook([M4B]))
    expect(readAloudState.options?.enabled.value).toBe(false)
    permissionMocks.demo.value = true
    mountPanel(makeBook())
    expect(readAloudState.options?.enabled.value).toBe(false)
    permissionMocks.demo.value = false
    permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_generate_read_aloud')
    mountPanel(makeBook())
    expect(readAloudState.options?.enabled.value).toBe(false)
  })

  it('offers Create and Modify once upstream says the book is available', () => {
    expect(slot(mountPanel())).toBeUndefined()
    expect(slot(offerable())).toMatchObject({ variant: 'notCreated', action: { id: 'createReadAloud' } })
  })

  it('creates with the dialog’s defaults in one click', async () => {
    const panel = offerable()
    panel.runAction('createReadAloud')
    await flushPromises()
    expect(preferencesState.load).toHaveBeenCalled()
    expect(readAloudState.create).toHaveBeenCalledWith({ epubFileId: 101, audioFileIds: [102, 103, 104], language: 'en', granularity: 'sentence' })
    expect(panel.readAloudDialog.value.open).toBe(false)
  })

  it('falls back to the saved default language', async () => {
    readAloudState.capability.value = makeCapability()
    preferencesState.load.mockImplementation(async () => {
      preferencesState.defaultLanguage.value = 'de'
    })
    mountPanel({ ...makeBook(), language: 'Dutch' } as BookDetail).runAction('createReadAloud')
    await flushPromises()
    expect(readAloudState.create.mock.calls[0]![0].language).toBe('de')
  })

  it('opens the dialog instead when no supported language is known', async () => {
    readAloudState.capability.value = makeCapability()
    const panel = mountPanel({ ...makeBook(), language: 'Dutch' } as BookDetail)
    panel.runAction('createReadAloud')
    await flushPromises()
    expect(readAloudState.create).not.toHaveBeenCalled()
    expect(panel.readAloudDialog.value).toMatchObject({ open: true, defaultLanguage: 'Dutch', error: null })
  })

  it('shows a failed one-click start in the slot note', async () => {
    readAloudState.create.mockResolvedValue({ ok: false, errorKey: 'book.detail.files.readAloud.errors.createConflict' })
    const panel = offerable()
    panel.runAction('createReadAloud')
    await flushPromises()
    expect(slot(panel)).toMatchObject({ note: { key: 'book.detail.files.readAloud.errors.createConflict' } })
  })

  it('Modify opens the dialog, which creates and closes on success or keeps the error', async () => {
    const panel = offerable()
    panel.runAction('modifyReadAloud')
    expect(panel.readAloudDialog.value).toMatchObject({ open: true, capability: readAloudState.capability.value, busy: false })
    const input = { epubFileId: 101, audioFileIds: [103], language: 'fr', granularity: 'word' as const }
    readAloudState.create.mockResolvedValueOnce({ ok: false, errorKey: 'book.detail.files.readAloud.errors.create' })
    await panel.createReadAloudFromDialog(input)
    expect(panel.readAloudDialog.value).toMatchObject({ open: true, error: 'book.detail.files.readAloud.errors.create' })
    await panel.createReadAloudFromDialog(input)
    expect(readAloudState.create).toHaveBeenLastCalledWith(input)
    expect(panel.readAloudDialog.value.open).toBe(false)
  })

  it('keeps the dialog open while a start is in flight', () => {
    const panel = offerable()
    panel.runAction('modifyReadAloud')
    readAloudState.action.value = 'create'
    panel.closeReadAloudDialog()
    expect(panel.readAloudDialog.value).toMatchObject({ open: true, busy: true })
    readAloudState.action.value = null
    panel.closeReadAloudDialog()
    expect(panel.readAloudDialog.value.open).toBe(false)
  })

  it('follows a running job and cancels it', () => {
    readAloudState.job.value = makeJob({ status: 'processing', stage: 'aligning', progress: 30 })
    const panel = mountPanel()
    expect(slot(panel)).toMatchObject({ variant: 'processing', progress: { stage: 'aligning', percent: 30 }, cancel: { id: 'cancelReadAloud' } })
    expect(panel.chain.value.header.label).toEqual({ key: 'book.detail.editionLink.chain.header.notSyncing' })
    panel.runAction('cancelReadAloud')
    expect(readAloudState.cancel).toHaveBeenCalledOnce()
  })

  it('retries a failed job while its work is kept, and shows upstream’s error', () => {
    readAloudState.job.value = makeJob({ status: 'failed', errorCode: 'alignment_failed', retryableUntil: '2999-01-01T00:00:00.000Z' })
    const panel = mountPanel()
    expect(slot(panel)).toMatchObject({
      variant: 'failed',
      note: { key: 'book.detail.files.readAloud.errors.job.alignment_failed' },
      action: { id: 'retryReadAloud' },
      secondary: { id: 'reviewReadAloud' },
    })
    panel.runAction('retryReadAloud')
    expect(readAloudState.retry).toHaveBeenCalledOnce()
  })

  it('drops a dismissed or finished job', () => {
    readAloudState.job.value = makeJob({ status: 'failed', dismissedAt: '2026-01-02T00:00:00.000Z' })
    expect(slot(mountPanel())).toBeUndefined()
    readAloudState.job.value = makeJob({ status: 'cancelled' })
    expect(slot(mountPanel())).toBeUndefined()
  })

  it('Review opens the Files tab with the job details expanded', () => {
    readAloudState.job.value = makeJob({ status: 'awaiting_review' })
    const panel = mountPanel()
    expect(slot(panel)).toMatchObject({ variant: 'review' })
    panel.runAction('reviewReadAloud')
    expect(routerMocks.push).toHaveBeenCalledWith({ name: 'book-detail', params: { bookId: 10 }, query: { tab: 'files', readAloud: 'details' } })
  })

  it('reloads the book when a job publishes, so the chain gains the read-aloud', async () => {
    const updated = makeBook([EPUB, M4B, READ_ALONG], sync())
    apiMocks.api.mockResolvedValue(jsonResponse(updated))
    const onSaved = vi.fn<(book: BookDetail) => void>()
    mountPanel(makeBook(), { onSaved })
    readAloudState.options?.onJobCompleted?.(makeJob({ status: 'completed' }))
    await flushPromises()
    expect(apiMocks.api).toHaveBeenCalledWith('/api/v1/books/10')
    expect(onSaved).toHaveBeenCalledWith(updated)
  })

  it('locks the panel while a job action is in flight', () => {
    const panel = mountPanel()
    readAloudState.action.value = 'cancel'
    expect(panel.busy.value).toBe(true)
  })
})

describe('Audiobookshelf', () => {
  it('pauses through the confirm', async () => {
    absMatch()
    absApiMocks.exclusion.mockResolvedValue({})
    const panel = mountPanel()
    panel.switchConnector('audiobook-abs', false)
    expect(panel.dialog.value?.kind).toBe('pauseAbs')
    await panel.confirmDialog()
    expect(absApiMocks.exclusion).toHaveBeenCalledWith('abs-1', true)
    expect(panel.dialog.value).toBeNull()
  })

  it('cancels the confirm without pausing', () => {
    absMatch()
    const panel = mountPanel()
    panel.switchConnector('audiobook-abs', false)
    panel.cancelDialog()
    expect(panel.dialog.value).toBeNull()
    expect(absApiMocks.exclusion).not.toHaveBeenCalled()
  })

  it('opens the in-place search from the Match ghost', () => {
    const panel = mountPanel()
    panel.runAction('change')
    expect(panel.changing.value).toBe('abs')
    panel.search.close()
    expect(panel.changing.value).toBeNull()
  })

  it('stays out of the chain without its permission', () => {
    permissionMocks.hasPermission.mockImplementation((name) => name !== 'audiobookshelf_sync')
    absMatch()
    expect(rowIds(mountPanel()).some((id) => id.includes('abs'))).toBe(false)
  })
})

describe('opening', () => {
  it('decides the view once the statuses have loaded', async () => {
    const panel = mountPanel()
    panel.prepareView(10_000)
    await panel.handleOpen()
    expect(absState.loadConfigured).toHaveBeenCalled()
    expect(absState.refreshLive).toHaveBeenCalled()
    expect(alignmentState.fetchStatus).toHaveBeenCalledWith(10)
    expect(panel.viewMode.value).toBe('modify')
  })

  it('leaves Audiobookshelf alone on open for a book without audio', async () => {
    await mountPanel(makeBook([EPUB, READ_ALONG], sync())).handleOpen()
    expect(absState.loadConfigured).not.toHaveBeenCalled()
  })

  it('opens compact when Modify does not fit, and Modify when something needs attention', async () => {
    const panel = mountPanel()
    panel.prepareView(0)
    await panel.handleOpen()
    expect(panel.viewMode.value).toBe('compact')
    alignmentState.status.value = 'failed'
    await flushPromises()
    expect(panel.viewMode.value).toBe('modify')
  })

  it('colours the trigger from the header and names its state', () => {
    alignmentState.status.value = 'ready'
    alignmentState.builtAt.value = '2026-10-01T00:00:00Z'
    const panel = mountPanel()
    expect(panel.triggerIconClass.value).toBe('text-success')
    expect(panel.triggerTooltip.value).toBe('Position sync: 2 of 2 in sync')
  })
})
