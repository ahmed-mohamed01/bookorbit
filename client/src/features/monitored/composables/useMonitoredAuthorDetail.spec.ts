import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import type { MonitoredAuthorDetail, MonitoredBookItem, MonitoredWork } from '@bookorbit/types'
import { createMonitoredBook, fetchMonitoredAuthorDetail, fetchMonitoredBooks, requestMonitoredWork, updateMonitoredWork } from '../api/monitored'
import { onMonitoredBookCreated } from '../lib/monitored-book-state'
import { storage } from '@/services/storage'
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

  it('replaces optimistic queue state with the request state returned by the server', async () => {
    requestWorkMock.mockResolvedValue(work({ requestIds: { ebook: 41 }, requestStatuses: { ebook: 'grabbed' } }))
    const { composable, wrapper } = mountComposable()
    await composable.load()

    await composable.queueWork('work-1', 'ebook')

    expect(composable.isQueued('work-1', 'ebook')).toBe(false)
    expect(composable.isQueued('work-1')).toBe(false)
    expect(composable.detail.value?.works[0]?.requestStatuses).toEqual({ ebook: 'grabbed' })
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

describe('useMonitoredAuthorDetail display options', () => {
  const reviewDetail = (): MonitoredAuthorDetail => {
    const base = detail()
    return {
      author: { ...base.author, counts: { ...base.author.counts, total: 1, hidden: 4 } },
      works: [
        work(),
        work({ id: 'box-set', title: 'The Complete Saga', verdict: 'suspect', kind: 'collection' }),
        work({ id: 'comic', title: 'The Comic', verdict: 'suspect', kind: 'graphic_novel' }),
        work({ id: 'obscure', title: 'Something Obscure', verdict: 'probable' }),
        work({ id: 'stub', title: 'Untitled', verdict: 'probable', flags: ['placeholder'] }),
        work({ id: 'buried', title: 'Buried', userVisibility: 'hidden' }),
      ],
    }
  }

  beforeEach(() => {
    storage.remove('monitored:authorDetail:display')
    fetchDetailMock.mockReset()
    fetchBooksMock.mockReset()
    fetchDetailMock.mockResolvedValue(reviewDetail())
    fetchBooksMock.mockResolvedValue(emptyBooksPage())
  })

  it('shows only the default class, while already knowing what the other switches would reveal', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1'])
    // Counts used to arrive only once a switch forced a second fetch, so the menu opened blank.
    expect(composable.displayCounts.value).toEqual({ hidden: 1, placeholder: 1, review: 3 })
    expect(composable.reviewKindCounts.value.all).toBe(3)
    wrapper.unmount()
  })

  it('never refetches for a switch, because every class was fetched up front', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()
    expect(fetchDetailMock).toHaveBeenCalledWith('author-1', expect.objectContaining({ includeHidden: true }))
    fetchDetailMock.mockClear()

    composable.setDisplay({ ...composable.display.value, review: true })
    composable.setDisplay({ ...composable.display.value, hidden: true })
    await Promise.resolve()

    expect(fetchDetailMock).not.toHaveBeenCalled()
    // Default + review + hidden; the placeholder stays out because its own switch is still off.
    expect(composable.visibleWorks.value).toHaveLength(5)
    wrapper.unmount()
  })

  it('counts each class once, so a placeholder is never also counted under review', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.displayCounts.value).toEqual({ hidden: 1, placeholder: 1, review: 3 })
    expect(composable.reviewKindCounts.value).toMatchObject({ all: 3, collection: 1, graphic_novel: 1, other: 1, anthology: 0 })
    wrapper.unmount()
  })

  it('narrows the review class to the picked kinds without disturbing the default list', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true })
    await composable.load()

    composable.setDisplay({ ...composable.display.value, reviewKinds: ['collection'] })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set'])

    // Several kinds at once is the point of the multi-select.
    composable.setDisplay({ ...composable.display.value, reviewKinds: ['collection', 'graphic_novel'] })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set', 'comic'])
    wrapper.unmount()
  })

  it('drops the selection when review is collapsed, so re-expanding starts from all', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection'] })
    await composable.load()

    composable.setDisplay({ ...composable.display.value, review: false, reviewKinds: 'all' })
    composable.setDisplay({ ...composable.display.value, review: true })

    expect(composable.display.value.reviewKinds).toBe('all')
    wrapper.unmount()
  })

  it('reveals a work the owner hid only when hidden is switched on', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, hidden: true })
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'buried'])
    wrapper.unmount()
  })

  it('falls back to all when a reload leaves every picked kind empty', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection'] })
    await composable.load()

    // The next author has a tray, but nothing in it is a collection, and an absent kind is not listed.
    fetchDetailMock.mockResolvedValue({
      author: detail().author,
      works: [work(), work({ id: 'comic', verdict: 'suspect', kind: 'graphic_novel' })],
    })
    await composable.load()

    expect(composable.display.value.reviewKinds).toBe('all')
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'comic'])
    wrapper.unmount()
  })

  it('keeps a selection that still matches something, even when part of it is absent here', async () => {
    const { composable, wrapper } = mountComposable()
    composable.setDisplay({ ...composable.display.value, review: true, reviewKinds: ['collection', 'duplicate'] })
    await composable.load()

    expect(composable.display.value.reviewKinds).toEqual(['collection', 'duplicate'])
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['work-1', 'box-set'])
    wrapper.unmount()
  })
})

describe('useMonitoredAuthorDetail release switches', () => {
  const dated = (): MonitoredAuthorDetail => ({
    author: detail().author,
    works: [
      work({ id: 'out', title: 'Already Out', ebookReleaseDate: '2020-01-01', ebookDatePrecision: 'day' }),
      work({ id: 'soon', title: 'Coming Soon', ebookReleaseDate: '2099-01-01', ebookDatePrecision: 'day' }),
      work({ id: 'tba', title: 'No Date At All' }),
    ],
  })

  beforeEach(() => {
    storage.remove('monitored:authorDetail:display')
    fetchDetailMock.mockReset()
    fetchBooksMock.mockReset()
    fetchDetailMock.mockResolvedValue(dated())
    fetchBooksMock.mockResolvedValue(emptyBooksPage())
  })

  it('lists released and upcoming together by default', async () => {
    const { composable, wrapper } = mountComposable()
    await composable.load()

    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['out', 'soon', 'tba'])
    wrapper.unmount()
  })

  it('leaves an undated work alone whichever release switch is off', async () => {
    // A work with no date is evidence of neither, and dropping it would swallow every
    // unannounced book in the catalog.
    const { composable, wrapper } = mountComposable()
    await composable.load()

    composable.setDisplay({ ...composable.display.value, upcoming: false })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['out', 'tba'])

    composable.setDisplay({ ...composable.display.value, upcoming: true, released: false })
    expect(composable.visibleWorks.value.map((entry) => entry.id)).toEqual(['soon', 'tba'])
    wrapper.unmount()
  })
})
