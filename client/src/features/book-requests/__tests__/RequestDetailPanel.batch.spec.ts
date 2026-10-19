import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { BatchUnitView, BookRequestItem } from '@bookorbit/types'

const fetchUnits = vi.fn<(id: number) => Promise<BatchUnitView[]>>()
const changeListeners: Array<() => void> = []
const requestRef = ref<BookRequestItem | null>(null)
let calls = 0

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '5' } }),
  useRouter: () => ({ push: vi.fn<(to: unknown) => void>(), replace: vi.fn<(to: unknown) => void>() }),
}))
vi.mock('../composables/useBatchGrab', () => ({ useBatchGrab: () => ({ fetchUnits }) }))
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
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => false }) }))
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
    requestRef.value = batchRequest()
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
})
