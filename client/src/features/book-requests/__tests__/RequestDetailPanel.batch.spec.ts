import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BatchUnitView, BookRequestItem } from '@bookorbit/types'

const fetchUnits = vi.fn<(id: number) => Promise<BatchUnitView[]>>()
const retry = vi.fn<(id: number) => Promise<string | null>>()
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn<(permission: string) => boolean>(() => false) }))
const toastError = vi.hoisted(() => vi.fn<(message: string, options?: unknown) => void>())
const changeListeners: Array<() => void> = []
const requestRef = ref<BookRequestItem | null>(null)
let calls = 0

vi.mock('vue-sonner', () => ({ toast: { error: toastError, success: vi.fn<() => void>() } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '5' } }),
  useRouter: () => ({ push: vi.fn<(to: unknown) => void>(), replace: vi.fn<(to: unknown) => void>() }),
}))
vi.mock('../composables/useBatchGrab', () => ({ useBatchGrab: () => ({ fetchUnits, retry, retrying: ref(false) }) }))
vi.mock('../composables/useBookRequestDetail', () => ({
  useBookRequestDetail: () => ({
    request: calls++ === 0 ? requestRef : ref(null),
    loading: ref(false),
    error: ref(null),
    fetchRequest: vi.fn<() => Promise<void>>(async () => {}),
    setRequest: vi.fn<(item: BookRequestItem) => void>(),
  }),
}))
vi.mock('../composables/useBookRequestProgress', () => ({
  useBookRequestProgress: () => ({
    progressByRequest: ref({}),
    onRequestsChanged: (fn: () => void) => changeListeners.push(fn),
    pruneSettledProgress: vi.fn<() => void>(),
  }),
}))
vi.mock('../composables/useCoalescedRefresh', () => ({ useCoalescedRefresh: (fn: () => void) => fn }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission }) }))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 1 }) }) }))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries: ref([]), fetchLibraries: vi.fn<() => Promise<void>>() }),
}))
vi.mock('../composables/useRequestDestinationDefault', () => ({
  requestLanguageOptions: () => [],
  useRequestDestinationDefault: () => ({
    load: vi.fn<() => Promise<void>>(),
    defaultFor: vi.fn<() => unknown>(),
    resolveDestination: () => ({ libraryId: null, folderId: null }),
  }),
}))

import RequestDetailPanel from '../components/RequestDetailPanel.vue'

function batchRequest(): BookRequestItem {
  return {
    id: 5,
    userId: 1,
    requesterUsername: 'u',
    requesterName: 'U',
    title: 'Discworld',
    subtitle: null,
    authors: [],
    seriesName: null,
    seriesIndex: null,
    isbn10: null,
    isbn13: null,
    publishedYear: null,
    language: null,
    coverUrl: null,
    providerKey: null,
    providerId: null,
    metadataSources: [],
    mediaKind: 'ebook',
    status: 'importing',
    preferredFormats: [],
    note: null,
    targetLibraryId: null,
    targetLibraryName: null,
    targetFolderId: null,
    decidedByUserId: null,
    decidedByUsername: null,
    decidedAt: null,
    decisionNote: null,
    matchedBookId: null,
    bookDockFileId: null,
    kind: 'batch',
    batch: { total: 2, inDock: 1, failed: 0 },
    selfServe: false,
    fulfillerUserId: null,
    statusReason: null,
    failureCode: null,
    failureMeta: null,
    subscribers: [],
    download: null,
    dismissed: false,
    companionRequestId: null,
    targetBookId: null,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
  } as BookRequestItem
}

function unit(index: number, status: BatchUnitView['status']): BatchUnitView {
  return {
    unitIndex: index,
    title: `Book ${index}`,
    primaryPath: `Pack/${index}.epub`,
    mediaKind: 'ebook',
    sizeBytes: null,
    status,
    bookDockFileId: null,
    errorMessage: null,
  }
}

describe('RequestDetailPanel batch units', () => {
  beforeEach(() => {
    changeListeners.length = 0
    calls = 0
    fetchUnits.mockReset()
    retry.mockReset()
    toastError.mockReset()
    hasPermission.mockImplementation(() => false)
    requestRef.value = batchRequest()
  })

  it.each([
    [2, 'Batch · 2 books'],
    [1, 'Batch · 1 book'],
    [0, 'Batch · 0 books'],
    [null, 'Batch'],
  ])('labels an authorless batch with total %s', async (total, expected) => {
    fetchUnits.mockResolvedValue([])
    requestRef.value = { ...batchRequest(), batch: total === null ? null : { total: total as number, inDock: 0, failed: 0 } }
    const wrapper = shallowMount(RequestDetailPanel)
    await flushPromises()
    expect(wrapper.text()).toContain(expected)
    expect(wrapper.text()).not.toContain('Author unknown')
  })

  it('loads units for a batch request and refreshes them on book-requests:changed', async () => {
    fetchUnits.mockResolvedValueOnce([unit(0, 'in_dock'), unit(1, 'placing')])
    const wrapper = shallowMount(RequestDetailPanel, { global: { stubs: { BatchUnitList: false } } })
    await flushPromises()

    expect(fetchUnits).toHaveBeenCalledWith(5)
    expect(wrapper.text()).toContain('Book 1')
    expect(wrapper.text()).toContain('Placing')

    fetchUnits.mockResolvedValueOnce([unit(0, 'in_dock'), unit(1, 'in_dock')])
    for (const listener of changeListeners) listener()
    await flushPromises()

    expect(fetchUnits).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Placing')
  })

  it('offers no single-request grab or download cancel on a batch', async () => {
    fetchUnits.mockResolvedValue([])
    requestRef.value = { ...batchRequest(), status: 'failed', download: { id: 9, status: 'failed' } as BookRequestItem['download'] }
    const wrapper = shallowMount(RequestDetailPanel)
    await flushPromises()

    const progress = wrapper.findComponent({ name: 'RequestDownloadProgress' })
    expect(progress.exists()).toBe(true)
    expect(progress.props('canRetry')).toBe(false)
    expect(progress.props('canCancel')).toBe(false)
  })

  it('does not load units for a single request', async () => {
    requestRef.value = { ...batchRequest(), kind: 'single', batch: null }
    shallowMount(RequestDetailPanel)
    await flushPromises()

    expect(fetchUnits).not.toHaveBeenCalled()
  })

  describe('Retry import', () => {
    const failed = () => ({ ...batchRequest(), status: 'failed' as const, statusReason: 'BookOrbit could not read the finished download' })
    const findRetry = (wrapper: ReturnType<typeof shallowMount>) => wrapper.findAll('button').find((button) => button.text() === 'Retry import')

    it('is offered on a failed batch to someone who may fulfil it, with its helper text', async () => {
      fetchUnits.mockResolvedValue([])
      hasPermission.mockImplementation(() => true)
      requestRef.value = failed()
      const wrapper = shallowMount(RequestDetailPanel, { global: { stubs: { Button: false, Primitive: false } } })
      await flushPromises()

      expect(findRetry(wrapper)).toBeDefined()
      expect(wrapper.text()).toContain('Imports the books again from the files already downloaded. Nothing downloads again.')
    })

    it.each([
      ['a user without the grab permissions', () => failed(), false],
      ['a batch that has not failed', () => batchRequest(), true],
      ['a single request', () => ({ ...failed(), kind: 'single' as const, batch: null }), true],
    ])('is hidden for %s', async (_label, make, permitted) => {
      fetchUnits.mockResolvedValue([])
      hasPermission.mockImplementation(() => permitted)
      requestRef.value = make()
      const wrapper = shallowMount(RequestDetailPanel, { global: { stubs: { Button: false, Primitive: false } } })
      await flushPromises()

      expect(findRetry(wrapper)).toBeUndefined()
    })

    it('calls retry with the request id and stays quiet on success', async () => {
      fetchUnits.mockResolvedValue([])
      retry.mockResolvedValue(null)
      hasPermission.mockImplementation(() => true)
      requestRef.value = failed()
      const wrapper = shallowMount(RequestDetailPanel, { global: { stubs: { Button: false, Primitive: false } } })
      await flushPromises()

      await findRetry(wrapper)!.trigger('click')
      await flushPromises()

      expect(retry).toHaveBeenCalledWith(5)
      expect(toastError).not.toHaveBeenCalled()
    })

    it('shows the server message when the retry is refused', async () => {
      fetchUnits.mockResolvedValue([])
      retry.mockResolvedValue('The download client no longer has this torrent, so there is nothing to import. Send the batch again.')
      hasPermission.mockImplementation(() => true)
      requestRef.value = failed()
      const wrapper = shallowMount(RequestDetailPanel, { global: { stubs: { Button: false, Primitive: false } } })
      await flushPromises()

      await findRetry(wrapper)!.trigger('click')
      await flushPromises()

      expect(toastError).toHaveBeenCalledWith('Could not retry the import', {
        description: 'The download client no longer has this torrent, so there is nothing to import. Send the batch again.',
      })
    })
  })
})
