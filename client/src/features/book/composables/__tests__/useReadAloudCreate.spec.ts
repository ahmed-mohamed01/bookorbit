import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type { BookDetail } from '@bookorbit/types'
import { makeCapability, makeJob } from '@/features/read-aloud/__tests__/fixtures'
import { useReadAloudCreate, type ReadAloudCreateOptions } from '../useReadAloudCreate'
import { createReadAloudPreferencesState, createReadAloudState } from './read-aloud-create-mocks'

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>(), demo: { value: false } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission, isDemoRestrictedAccount: permissionMocks.demo }),
}))

const routerMocks = vi.hoisted(() => ({ push: vi.fn<(to: unknown) => Promise<void>>() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerMocks.push }) }))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 1 }) }) }))

const apiMocks = vi.hoisted(() => ({ api: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>() }))
vi.mock('@/lib/api', () => ({ api: apiMocks.api }))

let readAloudState = createReadAloudState()
let preferencesState = createReadAloudPreferencesState()

vi.mock('@/features/read-aloud/composables/useReadAloudPreferences', () => ({ useReadAloudPreferences: () => preferencesState }))
vi.mock('@/features/read-aloud/composables/useReadAloud', () => ({
  useReadAloud: (options: import('@/features/read-aloud/composables/useReadAloud').UseReadAloudOptions) => {
    readAloudState.options = options
    return readAloudState
  },
}))

type FileSpec = { id: number; format: string; filename: string; readAlong?: boolean }

const EPUB: FileSpec = { id: 1, format: 'epub', filename: 'Dune.epub' }
const M4B: FileSpec = { id: 2, format: 'm4b', filename: 'Dune.m4b' }
const READ_ALONG: FileSpec = { id: 3, format: 'epub', filename: 'Dune (read-along).epub', readAlong: true }

function makeBook(files: FileSpec[] = [EPUB, M4B], language: string | null = 'en'): BookDetail {
  return {
    id: 10,
    language,
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
  } as unknown as BookDetail
}

function mountCreate(book: BookDetail = makeBook(), options: Partial<ReadAloudCreateOptions> = {}) {
  let create!: ReturnType<typeof useReadAloudCreate>
  mount(
    defineComponent({
      setup() {
        create = useReadAloudCreate({ book: () => book, ...options })
        return () => null
      },
    }),
  )
  return create
}

function offerable(book: BookDetail = makeBook()) {
  readAloudState.capability.value = makeCapability()
  return mountCreate(book)
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

beforeEach(() => {
  readAloudState = createReadAloudState()
  preferencesState = createReadAloudPreferencesState()
  routerMocks.push.mockReset().mockResolvedValue(undefined)
  permissionMocks.demo.value = false
  apiMocks.api.mockReset()
  permissionMocks.hasPermission.mockReset().mockReturnValue(true)
})

describe('useReadAloudCreate', () => {
  it('runs upstream’s generator only for a book with an EPUB and audio and no read-along, with the permission', () => {
    mountCreate()
    expect(readAloudState.options?.enabled.value).toBe(true)
    expect(readAloudState.options?.bookId.value).toBe(10)
    expect(readAloudState.options?.fileIds.value).toEqual([1, 2])
    expect(readAloudState.options?.viewerId.value).toBe(1)
    mountCreate(makeBook([EPUB, M4B, READ_ALONG]))
    expect(readAloudState.options?.enabled.value).toBe(false)
    mountCreate(makeBook([M4B]))
    expect(readAloudState.options?.enabled.value).toBe(false)
    permissionMocks.demo.value = true
    mountCreate()
    expect(readAloudState.options?.enabled.value).toBe(false)
    permissionMocks.demo.value = false
    permissionMocks.hasPermission.mockImplementation((name) => name !== 'library_generate_read_aloud')
    mountCreate()
    expect(readAloudState.options?.enabled.value).toBe(false)
  })

  it('reports the entry as available once upstream says so', () => {
    expect(mountCreate().slot.value.entry).toEqual({ kind: 'hidden' })
    expect(offerable().slot.value).toMatchObject({ entry: { kind: 'available' }, job: null, pending: null, errorKey: null })
  })

  it('creates with the dialog’s defaults in one click', async () => {
    const create = offerable()
    await create.create()
    expect(preferencesState.load).toHaveBeenCalled()
    expect(readAloudState.create).toHaveBeenCalledWith({ epubFileId: 101, audioFileIds: [102, 103, 104], language: 'en', granularity: 'sentence' })
    expect(create.dialog.value.open).toBe(false)
  })

  it('falls back to the saved default language', async () => {
    readAloudState.capability.value = makeCapability()
    preferencesState.load.mockImplementation(async () => {
      preferencesState.defaultLanguage.value = 'de'
    })
    await mountCreate(makeBook([EPUB, M4B], 'Dutch')).create()
    expect(readAloudState.create.mock.calls[0]![0].language).toBe('de')
  })

  it('opens the dialog instead when no supported language is known', async () => {
    readAloudState.capability.value = makeCapability()
    const create = mountCreate(makeBook([EPUB, M4B], 'Dutch'))
    await create.create()
    expect(readAloudState.create).not.toHaveBeenCalled()
    expect(create.dialog.value).toMatchObject({ open: true, defaultLanguage: 'Dutch', error: null })
  })

  it('keeps a failed one-click start as the slot error', async () => {
    readAloudState.create.mockResolvedValue({ ok: false, errorKey: 'book.detail.files.readAloud.errors.createConflict' })
    const create = offerable()
    await create.create()
    expect(create.slot.value.errorKey).toBe('book.detail.files.readAloud.errors.createConflict')
  })

  it('Options opens the dialog, which creates and closes on success or keeps the error', async () => {
    const create = offerable()
    create.openDialog()
    expect(create.dialog.value).toMatchObject({ open: true, capability: readAloudState.capability.value, busy: false })
    const input = { epubFileId: 101, audioFileIds: [103], language: 'fr', granularity: 'word' as const }
    readAloudState.create.mockResolvedValueOnce({ ok: false, errorKey: 'book.detail.files.readAloud.errors.create' })
    await create.createFromDialog(input)
    expect(create.dialog.value).toMatchObject({ open: true, error: 'book.detail.files.readAloud.errors.create' })
    await create.createFromDialog(input)
    expect(readAloudState.create).toHaveBeenLastCalledWith(input)
    expect(create.dialog.value.open).toBe(false)
  })

  it('keeps the dialog open while a start is in flight', () => {
    const create = offerable()
    create.openDialog()
    readAloudState.action.value = 'create'
    create.closeDialog()
    expect(create.dialog.value).toMatchObject({ open: true, busy: true })
    readAloudState.action.value = null
    create.closeDialog()
    expect(create.dialog.value.open).toBe(false)
  })

  it('follows a running job, locks while an action is in flight, and cancels it', () => {
    readAloudState.job.value = makeJob({ status: 'processing', stage: 'aligning', progress: 30 })
    const create = mountCreate()
    expect(create.slot.value.job).toMatchObject({ status: 'processing', stage: 'aligning', progress: 30, canCancel: true })
    create.cancel()
    expect(readAloudState.cancel).toHaveBeenCalledOnce()
    readAloudState.action.value = 'cancel'
    expect(create.slot.value.pending).toBe('cancel')
    expect(create.busy.value).toBe(true)
  })

  it('retries a failed job while its work is kept, and carries upstream’s error', () => {
    readAloudState.job.value = makeJob({ status: 'failed', errorCode: 'alignment_failed', retryableUntil: '2999-01-01T00:00:00.000Z' })
    const create = mountCreate()
    expect(create.slot.value.job).toMatchObject({
      status: 'failed',
      canRetry: true,
      errorKey: 'book.detail.files.readAloud.errors.job.alignment_failed',
    })
    create.retry()
    expect(readAloudState.retry).toHaveBeenCalledOnce()
  })

  it('drops a dismissed or finished job', () => {
    readAloudState.job.value = makeJob({ status: 'failed', dismissedAt: '2026-01-02T00:00:00.000Z' })
    expect(mountCreate().slot.value.job).toBeNull()
    readAloudState.job.value = makeJob({ status: 'cancelled' })
    expect(mountCreate().slot.value.job).toBeNull()
  })

  it('Review opens the Files tab with the job details expanded', () => {
    readAloudState.job.value = makeJob({ status: 'awaiting_review' })
    mountCreate().review()
    expect(routerMocks.push).toHaveBeenCalledWith({ name: 'book-detail', params: { bookId: 10 }, query: { tab: 'files', readAloud: 'details' } })
  })

  it('reloads the book when a job publishes, so the card gains the read-aloud', async () => {
    const updated = makeBook([EPUB, M4B, READ_ALONG])
    apiMocks.api.mockResolvedValue(jsonResponse(updated))
    const onBookChanged = vi.fn<(book: BookDetail) => void>()
    mountCreate(makeBook(), { onBookChanged })
    readAloudState.options?.onJobCompleted?.(makeJob({ status: 'completed' }))
    await flushPromises()
    expect(apiMocks.api).toHaveBeenCalledWith('/api/v1/books/10')
    expect(onBookChanged).toHaveBeenCalledWith(updated)
  })
})
