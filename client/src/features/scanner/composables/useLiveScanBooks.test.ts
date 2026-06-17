import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import type { BookCard, ScanBooksAddedEvent } from '@bookorbit/types'

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
}

vi.mock('./useScanProgress', () => ({
  getSocket: vi.fn(() => mockSocket),
}))

import { useLiveScanBooks } from './useLiveScanBooks'
import { getSocket } from './useScanProgress'

const mockGetSocket = vi.mocked(getSocket)

function makeBook(overrides: Partial<BookCard> = {}): BookCard {
  return {
    id: 1,
    status: 'active',
    title: 'Book Title',
    authors: ['Author'],
    seriesId: null,
    seriesName: null,
    seriesIndex: null,
    files: [],
    publishedYear: null,
    language: null,
    genres: [],
    rating: null,
    readingProgress: null,
    ...overrides,
  } as BookCard
}

function captureHandler(): (event: ScanBooksAddedEvent) => void {
  const call = mockSocket.on.mock.calls.find(([event]: [string]) => event === 'scan:books:added')
  const handler = call?.[1] as ((event: ScanBooksAddedEvent) => void) | undefined
  if (!handler) throw new Error('scan:books:added handler not registered')
  return handler
}

describe('useLiveScanBooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockGetSocket.mockReturnValue(mockSocket as ReturnType<typeof getSocket>)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start registers a socket listener for scan:books:added', () => {
    const libraryId = ref<number | null>(1)
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()

    expect(mockSocket.on).toHaveBeenCalledWith('scan:books:added', expect.any(Function))
  })

  it('stop removes the socket listener', () => {
    const libraryId = ref<number | null>(1)
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const { start, stop } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()
    stop()

    expect(mockSocket.off).toHaveBeenCalledWith('scan:books:added', handler)
  })

  it('prepends new book to existingBooks and increments total', () => {
    const existingBook = makeBook({ id: 1, title: 'Existing' })
    const existingBooks = ref<BookCard[]>([existingBook])
    const total = ref(1)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 99, title: 'New Book' })], libraryId: 1 })
    vi.runAllTimers()

    expect(existingBooks.value[0]?.id).toBe(99)
    expect(existingBooks.value[1]?.id).toBe(1)
    expect(total.value).toBe(2)
  })

  it('replaces updated book in-place and does not increment total', () => {
    const existingBook = makeBook({ id: 5, title: 'Old Title' })
    const existingBooks = ref<BookCard[]>([existingBook])
    const total = ref(1)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 5, title: 'Updated Title' })], libraryId: 1 })
    vi.runAllTimers()

    expect(existingBooks.value).toHaveLength(1)
    expect(existingBooks.value[0]?.title).toBe('Updated Title')
    expect(total.value).toBe(1)
  })

  it('flushes immediately in slow mode when maxBatchSize is reached (batch of 1)', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 10 })], libraryId: 1 })

    expect(existingBooks.value).toHaveLength(1)
    expect(existingBooks.value[0]?.id).toBe(10)
  })

  it('adds new book ids to newBookIds and clears them after ANIMATION_DURATION_MS (400ms)', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start, newBookIds } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 42 })], libraryId: 1 })
    vi.advanceTimersByTime(200)

    expect(newBookIds.value.has(42)).toBe(true)

    vi.advanceTimersByTime(600)

    expect(newBookIds.value.has(42)).toBe(false)
  })

  it('ignores events from a different libraryId', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 77 })], libraryId: 2 })
    vi.runAllTimers()

    expect(existingBooks.value).toHaveLength(0)
    expect(total.value).toBe(0)
  })

  it('clears buffer on flush even when existingBooks is empty', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({ books: [makeBook({ id: 20 })], libraryId: 1 })
    vi.runAllTimers()

    expect(existingBooks.value).toHaveLength(1)

    vi.clearAllMocks()
    mockGetSocket.mockReturnValue(mockSocket as ReturnType<typeof getSocket>)

    const { start: start2, newBookIds: newBookIds2 } = useLiveScanBooks(libraryId, existingBooks, total)
    start2()
    const handler2 = captureHandler()

    handler2({ books: [makeBook({ id: 21 })], libraryId: 1 })
    vi.runAllTimers()

    expect(newBookIds2.value.size).toBe(0)
  })

  it('stop clears pending flush timer and drops buffered books not yet flushed', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start, stop } = useLiveScanBooks(libraryId, existingBooks, total)

    start()

    stop()
    vi.runAllTimers()

    expect(existingBooks.value).toHaveLength(0)
  })

  it('start is idempotent (registers handler only once)', () => {
    const existingBooks = ref<BookCard[]>([])
    const total = ref(0)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    start()

    const calls = mockSocket.on.mock.calls.filter(([event]: [string]) => event === 'scan:books:added')
    expect(calls).toHaveLength(1)
  })

  it('handles mixed new and updated books in the same event', () => {
    const existingBook = makeBook({ id: 1, title: 'Old' })
    const existingBooks = ref<BookCard[]>([existingBook])
    const total = ref(1)
    const libraryId = ref<number | null>(1)
    const { start } = useLiveScanBooks(libraryId, existingBooks, total)

    start()
    const handler = captureHandler()

    handler({
      books: [makeBook({ id: 2, title: 'Brand New' }), makeBook({ id: 1, title: 'Updated' })],
      libraryId: 1,
    })
    vi.runAllTimers()

    expect(existingBooks.value).toHaveLength(2)
    expect(existingBooks.value[0]?.id).toBe(2)
    expect(existingBooks.value[1]?.title).toBe('Updated')
    expect(total.value).toBe(2)
  })
})
