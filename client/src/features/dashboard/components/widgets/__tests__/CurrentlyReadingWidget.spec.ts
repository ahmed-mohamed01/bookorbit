import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { CurrentlyReadingBook, CurrentlyReadingWidgetData } from '@bookorbit/types'
import CurrentlyReadingWidget from '../CurrentlyReadingWidget.vue'

const fetchCurrentlyReading = vi.fn<() => Promise<CurrentlyReadingWidgetData>>()
const { push } = vi.hoisted(() => ({ push: vi.fn<(...args: unknown[]) => void>() }))

vi.mock('@/features/dashboard/api/dashboard-widget.api', () => ({
  fetchCurrentlyReading: () => fetchCurrentlyReading(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/features/book/composables/useCoverVersions', () => ({
  useCoverVersions: () => ({ coverUrl: () => '/cover.jpg' }),
}))

const CoverSurfaceStub = {
  name: 'BookCoverSurface',
  props: ['isComic'],
  template: '<div data-testid="surface" :data-comic="isComic"><slot /></div>',
}
const CoverArtworkStub = {
  name: 'BookCoverArtwork',
  props: ['isComic', 'title'],
  template: '<div data-testid="artwork" :data-comic="isComic" :data-title="title" />',
}

function book(fileFormat: string | null): CurrentlyReadingBook {
  return {
    bookId: 1,
    title: 'Saga',
    authors: ['Brian K. Vaughan'],
    progress: 40,
    hasCover: true,
    fileId: 9,
    fileFormat,
    readFileId: 9,
    readFileFormat: fileFormat,
    readAlongFileId: null,
    hasAudio: false,
  }
}

function mountWidget(fileFormat: string | null) {
  fetchCurrentlyReading.mockResolvedValue({ books: [book(fileFormat)] })
  return mount(CurrentlyReadingWidget, {
    global: { stubs: { BookCoverSurface: CoverSurfaceStub, BookCoverArtwork: CoverArtworkStub } },
  })
}

describe('CurrentlyReadingWidget comic spine flag', () => {
  it('marks comic books as comics for the cover surface and artwork', async () => {
    const wrapper = mountWidget('cbz')
    await flushPromises()

    expect(wrapper.find('[data-testid="surface"]').attributes('data-comic')).toBe('true')
    expect(wrapper.find('[data-testid="artwork"]').attributes('data-comic')).toBe('true')
  })

  it('does not mark non-comic books as comics', async () => {
    const wrapper = mountWidget('epub')
    await flushPromises()

    expect(wrapper.find('[data-testid="surface"]').attributes('data-comic')).toBe('false')
  })

  it('treats a null file format as non-comic', async () => {
    const wrapper = mountWidget(null)
    await flushPromises()

    expect(wrapper.find('[data-testid="surface"]').attributes('data-comic')).toBe('false')
  })
})

function edition(bookId: number, title: string, lastActivityAt: string | null): CurrentlyReadingBook {
  return { ...book('epub'), bookId, title, fileId: bookId * 10, editionGroupId: 4, lastActivityAt }
}

function mountBooks(books: CurrentlyReadingBook[]) {
  fetchCurrentlyReading.mockResolvedValue({ books })
  return mount(CurrentlyReadingWidget, {
    global: { stubs: { BookCoverSurface: CoverSurfaceStub, BookCoverArtwork: CoverArtworkStub } },
  })
}

const linkedEditions = [
  edition(1, 'Last Argument of Kings (ebook)', '2026-10-01T10:00:00Z'),
  edition(2, 'Last Argument of Kings (audiobook)', '2026-10-05T10:00:00Z'),
  edition(3, 'Last Argument of Kings (read-along)', null),
]

describe('CurrentlyReadingWidget linked editions', () => {
  it('stacks linked editions into one row with a cover fan', async () => {
    const wrapper = mountBooks(linkedEditions)
    await flushPromises()

    expect(wrapper.findAll('.group\\/book')).toHaveLength(1)
    const fan = wrapper.find('[role="img"]')
    expect(fan.attributes('aria-label')).toBe('3 editions')
    expect(fan.findAll('[data-testid="artwork"]')).toHaveLength(3)
    expect(fan.findAll('[data-testid="edition-link-pill"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="surface"]').exists()).toBe(false)
  })

  it('titles the row after the most recently read edition', async () => {
    const wrapper = mountBooks(linkedEditions)
    await flushPromises()

    expect(wrapper.find('p.font-semibold').text()).toBe('Last Argument of Kings (audiobook)')
  })

  it('opens the most recently read edition when the row is clicked', async () => {
    push.mockClear()
    const wrapper = mountBooks(linkedEditions)
    await flushPromises()

    await wrapper.find('.group\\/book').trigger('click')

    expect(push).toHaveBeenCalledWith({ name: 'book-detail', params: { bookId: 2 } })
  })

  it('renders a book without an edition group as a single cover row', async () => {
    const wrapper = mountBooks([{ ...book('epub'), bookId: 99 }, ...linkedEditions])
    await flushPromises()

    const rows = wrapper.findAll('.group\\/book')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('[data-testid="surface"]').exists()).toBe(true)
    expect(rows[0]!.find('[role="img"]').exists()).toBe(false)
    expect(rows[0]!.findAll('[data-testid="artwork"]')).toHaveLength(1)
  })
})
