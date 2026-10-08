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
    selfServe: false,
    fulfillerUserId: null,
    statusReason: null,
    failureCode: null,
    failureMeta: null,
    subscribers: [],
    download: null,
    dismissed: false,
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
