import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { BookRequestItem } from '@bookorbit/types'

import RequestListTable from '../components/RequestListTable.vue'

const LONG_TITLE = 'Teddy and Booker T: How Two American Icons Blazed a Path for Racial Equality (Unabridged)'
const UNREADABLE_PATH_REASON =
  'The downloaded content is not readable at /Volumes/Data/downloads/torrents/complete/bookorbit/The_Fires_of_December_by_Brandon_Sanderson.epub'

function request(overrides: Partial<BookRequestItem> = {}): BookRequestItem {
  return {
    id: 1613,
    userId: 1,
    requesterUsername: 'reporter',
    requesterName: 'Issue Reporter',
    title: LONG_TITLE,
    subtitle: null,
    authors: ['Brian Kilmeade'],
    seriesName: null,
    seriesIndex: null,
    isbn10: null,
    isbn13: null,
    publishedYear: 2021,
    language: 'en',
    coverUrl: null,
    providerKey: null,
    providerId: null,
    metadataSources: [],
    mediaKind: 'audiobook',
    status: 'available',
    preferredFormats: [],
    note: null,
    targetLibraryId: 1,
    targetLibraryName: 'Audiobooks',
    targetFolderId: null,
    decidedByUserId: null,
    decidedByUsername: null,
    decidedAt: null,
    decisionNote: null,
    matchedBookId: 42,
    bookDockFileId: null,
    kind: 'single',
    batch: null,
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
    ...overrides,
  }
}

function render(item = request()) {
  return mount(RequestListTable, {
    props: {
      requests: [item],
      canManage: true,
      canSelfFulfil: true,
      currentUserId: 1,
      busyIds: new Set<number>(),
      progressByRequest: {},
      density: 'comfortable',
      sortBy: 'createdAt',
      sortDir: 'desc',
      selectedIds: [],
    },
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        RequestCover: true,
        RequestPipeline: true,
        RequestRowActions: true,
        RequestStatusBadge: true,
      },
    },
  })
}

describe('RequestListTable', () => {
  it.each([
    [{ kind: 'batch', authors: [], batch: { total: 1, filed: 0, inDock: 0, failed: 0 } }, 'Batch · 1 book'],
    [{ kind: 'batch', authors: [], batch: null }, 'Batch'],
    [{ kind: 'batch', authors: ['Terry Pratchett'] }, 'Terry Pratchett'],
    [{ kind: 'single', authors: [] }, 'Author unknown'],
  ] as const)('shows the request author line for %j', (overrides, expected) => {
    expect(render(request({ ...overrides, authors: [...overrides.authors] })).text()).toContain(expected)
  })

  it('constrains every intrinsic sizing boundary around a long title', () => {
    const wrapper = render()
    const titleButton = wrapper.findAll('tbody button').find((button) => button.text() === LONG_TITLE)

    expect(titleButton).toBeDefined()
    expect(titleButton!.classes()).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))

    const titleRow = titleButton!.element.parentElement
    const titleBlock = titleRow?.parentElement
    const titleLayout = titleBlock?.parentElement
    const titleCell = titleLayout?.parentElement

    expect(titleRow?.classList.contains('min-w-0')).toBe(true)
    expect(titleBlock?.classList.contains('min-w-0')).toBe(true)
    expect(titleLayout?.classList.contains('min-w-0')).toBe(true)
    expect(titleCell?.tagName).toBe('TD')
    expect(titleCell?.classList.contains('max-w-0')).toBe(true)
  })

  it('keeps the complete title available to the title button', () => {
    const wrapper = render()
    const titleButton = wrapper.findAll('tbody button').find((button) => button.text() === LONG_TITLE)

    expect(titleButton?.text()).toBe(LONG_TITLE)
  })

  it('keeps an unbreakable failure path from widening the outcome column', () => {
    const wrapper = render(request({ status: 'failed', statusReason: UNREADABLE_PATH_REASON }))
    const failure = wrapper.findAll('tbody p').find((paragraph) => paragraph.text() === UNREADABLE_PATH_REASON)

    expect(failure).toBeDefined()
    expect(failure!.classes()).toEqual(expect.arrayContaining(['line-clamp-2', 'break-words']))
    expect(failure!.attributes('title')).toBe(UNREADABLE_PATH_REASON)

    const outcomeCell = failure!.element.parentElement
    expect(outcomeCell?.tagName).toBe('TD')
    expect(outcomeCell?.classList.contains('max-w-0')).toBe(true)
  })

  it('gives Outcome a share of the table and leaves Title as the only column without a width', () => {
    const wrapper = render()
    const headers = wrapper.findAll('thead th')
    const titleHeader = headers.find((header) => header.attributes('aria-sort') !== undefined)
    const outcomeHeader = headers.find((header) => header.text() !== '' && !header.find('button').exists())

    expect(titleHeader).toBeDefined()
    expect(outcomeHeader).toBeDefined()
    expect(outcomeHeader!.classes()).toContain('w-1/5')
    expect(titleHeader!.classes().some((cls) => cls.startsWith('w-'))).toBe(false)
  })
})

describe('RequestListTable pairs', () => {
  const ebook = request({ id: 10, mediaKind: 'ebook', status: 'pending', title: 'Dune', companionRequestId: 11, matchedBookId: null })
  const audiobook = request({ id: 11, mediaKind: 'audiobook', status: 'downloading', title: 'Dune', companionRequestId: 10, matchedBookId: null })

  function renderPair(selectedIds: number[] = []) {
    return mount(RequestListTable, {
      props: {
        requests: [{ ...ebook, companion: audiobook }],
        canManage: true,
        canSelfFulfil: false,
        currentUserId: 1,
        busyIds: new Set<number>(),
        progressByRequest: {},
        density: 'comfortable',
        sortBy: 'createdAt',
        sortDir: 'desc',
        selectedIds,
      },
      global: {
        stubs: {
          RouterLink: RouterLinkStub,
          RequestCover: true,
          RequestPipeline: true,
          RequestStatusBadge: { props: ['status'], template: '<span class="status-badge">{{ status }}</span>' },
          RequestPairRowActions: {
            props: ['row'],
            emits: ['approve'],
            template: '<button class="pair-approve" @click="$emit(\'approve\', [row, row.companion])">approve</button>',
          },
        },
      },
    })
  }

  it('renders the pair as one row with a lane per half, the ebook first', () => {
    const wrapper = renderPair()

    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    const lanes = wrapper
      .get('table')
      .findAll('.status-badge')
      .map((badge) => badge.text())
    expect(lanes).toEqual(['pending', 'downloading'])
    expect(wrapper.find('table').text()).toContain('E-book and audiobook')
  })

  it('hands a row press on to the page with exactly the halves it applies to', async () => {
    const wrapper = renderPair()

    await wrapper.get('table .pair-approve').trigger('click')

    expect(wrapper.emitted('pair-approve')?.[0]?.[0]).toEqual([expect.objectContaining({ id: 10 }), expect.objectContaining({ id: 11 })])
  })

  it('ticks the row only when every half a bulk action can reach is selected', () => {
    // Only the pending ebook can be acted on in bulk; the downloading audiobook cannot.
    expect((renderPair([10]).get('table tbody input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect((renderPair([]).get('table tbody input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('does not make an approved batch row selectable', () => {
    const wrapper = render(request({ kind: 'batch', batch: { total: 3, filed: 0, inDock: 0, failed: 0 }, status: 'approved' }))

    expect(wrapper.findAll('input[type="checkbox"]').filter((box) => !(box.element as HTMLInputElement).disabled)).toHaveLength(0)
  })

  it('shows a batch row with its unit count', () => {
    const wrapper = render(request({ kind: 'batch', batch: { total: 12, filed: 0, inDock: 0, failed: 0 }, status: 'downloading' }))

    expect(wrapper.text()).toContain('Batch · 12 books')
  })

  it('shows N of M in Book Dock while importing', () => {
    const wrapper = render(request({ kind: 'batch', batch: { total: 12, filed: 0, inDock: 5, failed: 0 }, status: 'importing' }))

    expect(wrapper.text()).toContain('5 of 12 in Book Dock')
    expect(wrapper.text()).not.toContain('Batch · 12 books')
    const bar = wrapper.findAll('[role="progressbar"]').find((el) => el.attributes('aria-valuemax') === '12')
    expect(bar?.attributes('aria-valuenow')).toBe('5')
  })

  it('shows filed units in the library', () => {
    const wrapper = render(request({ kind: 'batch', batch: { total: 12, filed: 3, inDock: 10, failed: 2 }, status: 'available' }))
    expect(wrapper.text()).toContain('3 of 12 in library')
  })

  it('keeps the N of M count once the batch has finished', () => {
    const wrapper = render(request({ kind: 'batch', batch: { total: 12, filed: 0, inDock: 10, failed: 2 }, status: 'available' }))

    expect(wrapper.text()).toContain('10 of 12 in Book Dock · 2 failed')
    expect(wrapper.text()).not.toContain('Batch · 12 books')
  })

  it('batch rows use the live download progress like single requests', () => {
    const item = request({
      kind: 'batch',
      batch: { total: 3, filed: 0, inDock: 0, failed: 0 },
      status: 'downloading',
      download: {
        id: 7,
        status: 'downloading',
        progressPercent: 10,
        downloadedBytes: 100,
        totalBytes: 1000,
      } as BookRequestItem['download'],
    })
    const wrapper = render(item)
    wrapper.setProps({
      progressByRequest: {
        [item.id]: { requestId: item.id, downloadId: 7, status: 'downloading', progressPercent: 64, downloadedBytes: 640, totalBytes: 1000 },
      },
    })

    return wrapper.vm.$nextTick().then(() => {
      const bars = wrapper.findAll('[role="progressbar"]')
      expect(bars.some((bar) => bar.attributes('aria-valuenow') === '64')).toBe(true)
    })
  })
})
