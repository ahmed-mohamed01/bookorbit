import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BookCard } from '@bookorbit/types'
import CollapsedSeriesCard from '../CollapsedSeriesCard.vue'
import { useDisplaySettings } from '@/composables/useDisplaySettings'

const mockRouterPush = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: mockRouterPush }),
    useRoute: () => ({ fullPath: '/test-path' }),
  }
})

vi.mock('../BookCoverPlaceholder.vue', () => ({
  default: { template: '<div class="book-cover-placeholder" />' },
}))

function makeBook(overrides?: Partial<BookCard>): BookCard {
  return {
    id: 1,
    status: 'present',
    title: 'Book One',
    authors: ['Author A'],
    seriesName: 'The Arc',
    seriesIndex: 1,
    files: [],
    publishedYear: null,
    language: null,
    genres: [],
    tags: [],
    rating: null,
    readingProgress: null,
    readStatus: null,
    addedAt: '2024-01-01T00:00:00.000Z',
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
    collapsedSeries: {
      bookCount: 5,
      readCount: 2,
      coverBookIds: [1, 2, 3, 4],
      seriesLatestAddedAt: '2024-06-01T00:00:00.000Z',
    },
    ...overrides,
  }
}

const { bookSpineOverlay, seriesCardCoverMode } = useDisplaySettings()

describe('CollapsedSeriesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seriesCardCoverMode.value = 'mosaic'
  })

  afterEach(() => {
    bookSpineOverlay.value = 'off'
    seriesCardCoverMode.value = 'mosaic'
  })

  it('renders four cover tiles when all books are represented by covers', () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          collapsedSeries: { bookCount: 6, readCount: 0, coverBookIds: [1, 2, 3, 4, 5, 6], seriesLatestAddedAt: null },
        }),
      },
    })

    expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(4)
    expect(wrapper.findAll('[data-testid="series-cover-fallback"]')).toHaveLength(0)
  })

  it('renders img elements for each visible cover ID', () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: { book: makeBook({ collapsedSeries: { bookCount: 4, readCount: 0, coverBookIds: [10, 20, 30, 40], seriesLatestAddedAt: null } }) },
    })

    const imgs = wrapper.findAll('img')
    expect(imgs).toHaveLength(4)
    expect(imgs[0]!.attributes('src')).toBe('/api/v1/books/10/thumbnail')
    expect(imgs[1]!.attributes('src')).toBe('/api/v1/books/20/thumbnail')
  })

  it('does not pad missing slots when fewer than four covers exist', () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          collapsedSeries: { bookCount: 1, readCount: 0, coverBookIds: [5], seriesLatestAddedAt: null },
        }),
      },
    })

    expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="series-cover-fallback"]')).toHaveLength(0)
    expect(wrapper.findAll('.book-cover-placeholder')).toHaveLength(0)
  })

  it('shows a single fallback tile when coverBookIds is empty', () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          collapsedSeries: { bookCount: 3, readCount: 0, coverBookIds: [], seriesLatestAddedAt: null },
        }),
      },
    })

    expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="series-cover-fallback"]')).toHaveLength(1)
    expect(wrapper.findAll('.book-cover-placeholder')).toHaveLength(1)
  })

  it('shows count badge with bookCount', () => {
    const wrapper = mount(CollapsedSeriesCard, { props: { book: makeBook() } })

    const badge = wrapper.find('[data-testid="series-count-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('5')
  })

  it('shows the series name only once after removing the footer title', () => {
    const wrapper = mount(CollapsedSeriesCard, { props: { book: makeBook() } })

    const seriesNameInstances = wrapper
      .findAll('p')
      .map((node) => node.text())
      .filter((text) => text === 'The Arc')

    expect(seriesNameInstances).toHaveLength(1)
  })

  it('shows author name', () => {
    const wrapper = mount(CollapsedSeriesCard, { props: { book: makeBook() } })

    expect(wrapper.text()).toContain('Author A')
  })

  it('navigates to /series/:encodedName on click', async () => {
    const wrapper = mount(CollapsedSeriesCard, { props: { book: makeBook() } })

    await wrapper.trigger('click')

    expect(mockRouterPush).toHaveBeenCalledWith({
      name: 'series-detail',
      params: { seriesName: 'The Arc' },
      query: { from: '/test-path' },
    })
  })

  it('encodes series name with special characters in URL', async () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: { book: makeBook({ seriesName: 'The Wheel & Time' }) },
    })

    await wrapper.trigger('click')

    expect(mockRouterPush).toHaveBeenCalledWith({
      name: 'series-detail',
      params: { seriesName: 'The Wheel & Time' },
      query: { from: '/test-path' },
    })
  })

  it('shows placeholder instead of img after @error fires', async () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          collapsedSeries: { bookCount: 2, readCount: 0, coverBookIds: [10, 20], seriesLatestAddedAt: null },
        }),
      },
    })

    const firstImg = wrapper.find('img')
    expect(firstImg.exists()).toBe(true)

    await firstImg.trigger('error')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.book-cover-placeholder')).toHaveLength(1)
  })

  it('uses at most 4 cover tiles even if more are provided', () => {
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          collapsedSeries: { bookCount: 6, readCount: 0, coverBookIds: [1, 2, 3, 4, 5, 6], seriesLatestAddedAt: null },
        }),
      },
    })

    expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(4)
    expect(wrapper.findAll('[data-testid="series-cover-fallback"]')).toHaveLength(0)
  })

  it('forces spine overlay off for audiobook series cards', () => {
    bookSpineOverlay.value = 'strong'
    const wrapper = mount(CollapsedSeriesCard, {
      props: {
        book: makeBook({
          files: [{ id: 5, format: 'm4b', role: 'primary', sizeBytes: null }],
        }),
      },
    })

    const cover = wrapper.find('.book-cover-surface')
    expect(cover.attributes('data-cover-spine')).toBe('off')
  })

  describe('single cover mode (non-mosaic)', () => {
    it('renders single cover for first-volume mode', () => {
      seriesCardCoverMode.value = 'first-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 5,
              readCount: 0,
              coverBookIds: [1, 2, 3, 4],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 10,
              latestVolumeBookId: 40,
              firstUnreadBookId: 20,
            },
          }),
        },
      })

      expect(wrapper.find('[data-testid="series-single-cover"]').exists()).toBe(true)
      expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(0)
      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.exists()).toBe(true)
      expect(img.attributes('src')).toBe('/api/v1/books/10/thumbnail')
    })

    it('renders single cover for latest-volume mode', () => {
      seriesCardCoverMode.value = 'latest-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 5,
              readCount: 0,
              coverBookIds: [1, 2, 3, 4],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 10,
              latestVolumeBookId: 40,
              firstUnreadBookId: 20,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.attributes('src')).toBe('/api/v1/books/40/thumbnail')
    })

    it('renders single cover for first-unread mode', () => {
      seriesCardCoverMode.value = 'first-unread'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 5,
              readCount: 2,
              coverBookIds: [1, 2, 3, 4],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 10,
              latestVolumeBookId: 40,
              firstUnreadBookId: 20,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.attributes('src')).toBe('/api/v1/books/20/thumbnail')
    })

    it('falls back to first coverBookId when volume ID is missing', () => {
      seriesCardCoverMode.value = 'first-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 3,
              readCount: 0,
              coverBookIds: [77, 88],
              seriesLatestAddedAt: null,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.attributes('src')).toBe('/api/v1/books/77/thumbnail')
    })

    it('first-unread falls back to firstVolumeBookId when firstUnreadBookId is missing', () => {
      seriesCardCoverMode.value = 'first-unread'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 3,
              readCount: 3,
              coverBookIds: [1, 2, 3],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 10,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.attributes('src')).toBe('/api/v1/books/10/thumbnail')
    })

    it('first-unread falls back to first coverBookId when both unread and first volume are missing', () => {
      seriesCardCoverMode.value = 'first-unread'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 3,
              readCount: 3,
              coverBookIds: [77, 88],
              seriesLatestAddedAt: null,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.attributes('src')).toBe('/api/v1/books/77/thumbnail')
    })

    it('shows count badge in single cover mode', () => {
      seriesCardCoverMode.value = 'first-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 7,
              readCount: 0,
              coverBookIds: [1, 2],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 1,
            },
          }),
        },
      })

      const badge = wrapper.find('[data-testid="series-count-badge"]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('7')
    })

    it('shows hover overlay with series name and author in single cover mode', () => {
      seriesCardCoverMode.value = 'latest-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            seriesName: 'Dune Saga',
            authors: ['Frank Herbert'],
            collapsedSeries: {
              bookCount: 3,
              readCount: 0,
              coverBookIds: [1, 2, 3],
              seriesLatestAddedAt: null,
              latestVolumeBookId: 3,
            },
          }),
        },
      })

      expect(wrapper.text()).toContain('Dune Saga')
      expect(wrapper.text()).toContain('Frank Herbert')
    })

    it('shows placeholder after single cover image error', async () => {
      seriesCardCoverMode.value = 'first-volume'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 2,
              readCount: 0,
              coverBookIds: [10, 20],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 10,
            },
          }),
        },
      })

      const img = wrapper.find('[data-testid="series-single-cover"] img')
      expect(img.exists()).toBe(true)

      await img.trigger('error')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('[data-testid="series-single-cover"] img').exists()).toBe(false)
      expect(wrapper.find('[data-testid="series-single-cover"] .book-cover-placeholder').exists()).toBe(true)
    })

    it('renders mosaic when mode is mosaic (default)', () => {
      seriesCardCoverMode.value = 'mosaic'
      const wrapper = mount(CollapsedSeriesCard, {
        props: {
          book: makeBook({
            collapsedSeries: {
              bookCount: 4,
              readCount: 0,
              coverBookIds: [1, 2, 3, 4],
              seriesLatestAddedAt: null,
              firstVolumeBookId: 1,
              latestVolumeBookId: 4,
            },
          }),
        },
      })

      expect(wrapper.find('[data-testid="series-single-cover"]').exists()).toBe(false)
      expect(wrapper.findAll('[data-testid="series-cover-tile"]')).toHaveLength(4)
    })
  })
})
