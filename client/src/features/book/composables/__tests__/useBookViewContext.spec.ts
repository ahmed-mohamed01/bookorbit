import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookCard } from '@bookorbit/types'
import { useBookNavigation } from '../useBookNavigation'
import { useBookViewContext } from '../useBookViewContext'
import type { BookPlaceholder, BookSlot } from '../useBookWindow'

function placeholder(id: number): BookPlaceholder {
  return { id, placeholder: true }
}

function makeBook(id: number): BookCard {
  return {
    id,
    status: 'active',
    title: `Book ${id}`,
    authors: [],
    seriesName: null,
    seriesIndex: null,
    files: [],
    publishedYear: null,
    language: null,
    genres: [],
    tags: [],
    rating: null,
    readingProgress: null,
    readStatus: null,
    addedAt: '2024-01-01T00:00:00Z',
    updatedAt: null,
    metadataScore: null,
    hasCover: false,
    hasMetadataLocks: false,
    lockedFields: [],
    subtitle: null,
    publisher: null,
    pageCount: null,
    isbn13: null,
    narrators: [],
  }
}

describe('useBookViewContext', () => {
  afterEach(() => {
    const nav = useBookNavigation()
    nav.setBookContext([], 0)
    nav.registerLoadMore(null)
  })

  it('keeps metadata navigation working after the source list view unmounts', async () => {
    const nav = useBookNavigation()
    const books = ref<BookCard[]>([makeBook(1), makeBook(2)])
    const total = ref(4)
    const loadMore = vi.fn<() => Promise<void>>(async () => {
      books.value = [makeBook(1), makeBook(2), makeBook(3), makeBook(4)]
    })

    const Harness = defineComponent({
      setup() {
        useBookViewContext(books, total, loadMore)
        return {}
      },
      template: '<div />',
    })

    const wrapper = mount(Harness)
    wrapper.unmount()

    const nextId = await nav.getNextId(2)

    expect(loadMore).toHaveBeenCalledTimes(1)
    expect(nextId).toBe(3)
  })

  it('reports the absolute slot index after a jump rail loads a far block', async () => {
    const nav = useBookNavigation()
    // First block (rows 0-1) plus a far block (rows 5000-5001) loaded; the
    // rows in between are still placeholders, as after a jump to "Z".
    const slots = ref<BookSlot[]>([
      makeBook(1),
      makeBook(2),
      ...Array.from({ length: 4998 }, (_, i) => placeholder(-(i + 1))),
      makeBook(5001),
      makeBook(5002),
    ])
    const total = ref(5002)
    const loadMore = vi.fn(async () => {})

    const Harness = defineComponent({
      setup() {
        useBookViewContext(slots, total, loadMore)
        return {}
      },
      template: '<div />',
    })

    const wrapper = mount(Harness)

    expect(nav.currentIndex(5001)).toBe(5000)
    expect(nav.currentIndex(5002)).toBe(5001)
    expect(nav.currentIndex(1)).toBe(0)
    expect(nav.total.value).toBe(5002)

    wrapper.unmount()
  })
})
