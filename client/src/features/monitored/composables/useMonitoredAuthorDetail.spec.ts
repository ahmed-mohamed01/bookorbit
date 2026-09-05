import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredAuthorDetail, MonitoredBookItem, MonitoredWork } from '@bookorbit/types'
import { createMonitoredBook, fetchMonitoredAuthorDetail, fetchMonitoredBooks, requestMonitoredWork, updateMonitoredWork } from '../api/monitored'
import { onMonitoredBookCreated } from '../lib/monitored-book-state'
import { useMonitoredAuthorDetail } from './useMonitoredAuthorDetail'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'author-1' }, query: {} }),
  useRouter: () => ({ replace: vi.fn<() => Promise<void>>() }),
}))

vi.mock('../api/monitored', () => ({
  fetchMonitoredAuthorDetail: vi.fn<() => Promise<MonitoredAuthorDetail>>(),
  fetchMonitoredBooks: vi.fn<() => Promise<{ items: MonitoredBookItem[]; total: number; page: number; size: number }>>(),
  createMonitoredBook: vi.fn<() => Promise<MonitoredBookItem>>(),
  requestMonitoredWork: vi.fn<() => Promise<never>>(),
  updateMonitoredAuthor: vi.fn<() => Promise<never>>(),
  updateMonitoredWork: vi.fn<() => Promise<MonitoredWork>>(),
}))

const fetchDetailMock = vi.mocked(fetchMonitoredAuthorDetail)
const fetchBooksMock = vi.mocked(fetchMonitoredBooks)
const createBookMock = vi.mocked(createMonitoredBook)
const requestWorkMock = vi.mocked(requestMonitoredWork)
const updateWorkMock = vi.mocked(updateMonitoredWork)

function emptyBooksPage() {
  return { items: [], total: 0, page: 0, size: 200 }
}

function bookItem(overrides: Partial<MonitoredBookItem> = {}): MonitoredBookItem {
  return {
    id: 'book-1',
    ownerUserId: 1,
    isShared: false,
    monitorAuthorId: 'author-1',
    workId: 'work-1',
    formats: ['ebook'],
    paused: false,
    addedAt: '2026-01-01',
    isOwner: true,
    authorName: 'A Writer',
    work: work(),
    ...overrides,
  }
}

function work(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

function detail(): MonitoredAuthorDetail {
  return {
    author: {
      id: 'author-1',
      ownerUserId: 1,
      isShared: false,
      authorName: 'A Writer',
      localAuthorId: null,
      providerIds: {},
      formats: { ebook: { mode: 'notify', libraryId: null, folderId: null }, audiobook: { mode: 'off', libraryId: null, folderId: null } },
      paused: false,
      addedAt: '2026-01-01',
      lastRefreshedAt: null,
      isOwner: true,
      counts: { total: 1, ebookOwned: 0, audioOwned: 0, hidden: 0 },
      nextReleaseAt: null,
      portraitAuthorId: null,
      description: null,
      website: null,
      genres: [],
    },
    works: [work()],
  }
}

function mountComposable() {
  let composable!: ReturnType<typeof useMonitoredAuthorDetail>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useMonitoredAuthorDetail()
        return () => null
      },
    }),
  )
  return { composable, wrapper }
}

describe('useMonitoredAuthorDetail', () => {
  beforeEach(() => {
    fetchDetailMock.mockReset()
    fetchBooksMock.mockReset()
    createBookMock.mockReset()
    requestWorkMock.mockReset()
    updateWorkMock.mockReset()
    fetchDetailMock.mockResolvedValue(detail())
    fetchBooksMock.mockResolvedValue(emptyBooksPage())
  })

  it('persists a hide through the API and reflects the server copy of the work', async () => {
    const hidden = work({ userVisibility: 'hidden' })
    updateWorkMock.mockResolvedValue(hidden)
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.updateWork('work-1', { hidden: true })

    expect(updateWorkMock).toHaveBeenCalledWith('work-1', { hidden: true })
    expect(composable.detail.value?.works[0]).toEqual(hidden)
    expect(composable.visibleWorks.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('surfaces a failed hide instead of pretending it stuck', async () => {
    updateWorkMock.mockRejectedValue(new Error('nope'))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await expect(composable.updateWork('work-1', { hidden: true })).rejects.toThrow('nope')
    expect(composable.visibleWorks.value).toHaveLength(1)
    wrapper.unmount()
  })

  it('offers no local-only stop path that skips the server', () => {
    const { composable, wrapper } = mountComposable()

    expect('stopMonitoringWork' in composable).toBe(false)
    wrapper.unmount()
  })

  it('passes auto-download when provided and omits it when undefined', async () => {
    requestWorkMock.mockResolvedValue(work({ requestIds: { ebook: 41, audiobook: 42 } }))
    const { composable, wrapper } = mountComposable()

    await composable.queueWork('work-1', 'ebook', false)
    await composable.queueWork('work-1', 'audiobook')

    expect(requestWorkMock).toHaveBeenNthCalledWith(1, 'work-1', { format: 'ebook', autoDownload: false })
    expect(requestWorkMock).toHaveBeenNthCalledWith(2, 'work-1', { format: 'audiobook' })
    wrapper.unmount()
  })

  it('prunes an optimistic queued format after a reload reports it owned', async () => {
    requestWorkMock.mockResolvedValue(work({ requestIds: { ebook: 41 } }))
    const loaded = detail()
    loaded.works = [work({ requestIds: { ebook: 41 }, ownedFormats: ['ebook'] })]
    fetchDetailMock.mockResolvedValue(loaded)
    const { composable, wrapper } = mountComposable()

    await composable.queueWork('work-1', 'ebook')
    expect(composable.isQueued('work-1', 'ebook')).toBe(true)

    await composable.load()

    expect(composable.isQueued('work-1', 'ebook')).toBe(false)
    expect(composable.isQueued('work-1')).toBe(false)
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail book monitoring', () => {
  beforeEach(() => {
    fetchDetailMock.mockReset()
    fetchBooksMock.mockReset()
    createBookMock.mockReset()
    requestWorkMock.mockReset()
    updateWorkMock.mockReset()
    fetchDetailMock.mockResolvedValue(detail())
    fetchBooksMock.mockResolvedValue(emptyBooksPage())
  })

  it('derives the active author formats, skipping any format set to off', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.monitoredFormats.value).toEqual(['ebook'])
    wrapper.unmount()
  })

  it('reports a work as not monitored until the books scan finds a matching entry', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.isBookMonitored('work-1')).toBe(false)

    fetchBooksMock.mockResolvedValue({ items: [bookItem()], total: 1, page: 0, size: 200 })
    await composable.loadMonitoredBooks()

    expect(composable.isBookMonitored('work-1')).toBe(true)
    wrapper.unmount()
  })

  it('only matches a books entry for the same monitor author, not just the same work id', async () => {
    fetchBooksMock.mockResolvedValue({ items: [bookItem({ monitorAuthorId: 'author-2' })], total: 1, page: 0, size: 200 })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.loadMonitoredBooks()

    expect(composable.isBookMonitored('work-1')).toBe(false)
    wrapper.unmount()
  })

  it('scans every page of the books list up to the retention cap', async () => {
    fetchBooksMock
      .mockResolvedValueOnce({ items: [bookItem({ id: 'b1', workId: 'w1' })], total: 2, page: 0, size: 200 })
      .mockResolvedValueOnce({ items: [bookItem({ id: 'b2', workId: 'w2' })], total: 2, page: 1, size: 200 })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.loadMonitoredBooks()

    expect(fetchBooksMock).toHaveBeenCalledTimes(2)
    expect(composable.isBookMonitored('w1')).toBe(true)
    expect(composable.isBookMonitored('w2')).toBe(true)
    wrapper.unmount()
  })

  it('creates a monitored book with the author monitor id, work id, and active formats only', async () => {
    createBookMock.mockResolvedValue(bookItem())
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.monitorBook(work())

    expect(createBookMock).toHaveBeenCalledWith({ monitorAuthorId: 'author-1', workId: 'work-1', formats: ['ebook'] })
    expect(composable.isBookMonitored('work-1')).toBe(true)
    wrapper.unmount()
  })

  it('notifies other views once a monitored book is created', async () => {
    createBookMock.mockResolvedValue(bookItem())
    const listener = vi.fn<() => void>()
    const unsubscribe = onMonitoredBookCreated(listener)
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.monitorBook(work())

    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    wrapper.unmount()
  })

  it('does not call the API again for a work that is already monitored', async () => {
    fetchBooksMock.mockResolvedValue({ items: [bookItem()], total: 1, page: 0, size: 200 })
    const { composable, wrapper } = mountComposable()
    await composable.load()
    await composable.loadMonitoredBooks()

    await composable.monitorBook(work())

    expect(createBookMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('marks a work as in-flight while the create call is pending and clears it after', async () => {
    let resolveCreate!: (value: MonitoredBookItem) => void
    createBookMock.mockReturnValue(new Promise<MonitoredBookItem>((resolve) => (resolveCreate = resolve)))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    const pending = composable.monitorBook(work())
    expect(composable.isMonitoringBook('work-1')).toBe(true)

    resolveCreate(bookItem())
    await pending

    expect(composable.isMonitoringBook('work-1')).toBe(false)
    wrapper.unmount()
  })

  it('surfaces a failed create instead of pretending it stuck', async () => {
    createBookMock.mockRejectedValue(new Error('nope'))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await expect(composable.monitorBook(work())).rejects.toThrow('nope')
    expect(composable.isBookMonitored('work-1')).toBe(false)
    expect(composable.isMonitoringBook('work-1')).toBe(false)
    wrapper.unmount()
  })
})
