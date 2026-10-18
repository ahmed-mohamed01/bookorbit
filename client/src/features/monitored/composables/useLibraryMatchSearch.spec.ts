import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { MonitoredFormat, BookSearchOption } from '@bookorbit/types'
import { searchLibraryBooks } from '../api/monitored'
import { useLibraryMatchSearch } from './useLibraryMatchSearch'

vi.mock('../api/monitored', () => ({ LIBRARY_SEARCH_LIMIT: 20, searchLibraryBooks: vi.fn<() => Promise<BookSearchOption[]>>() }))
const searchMock = vi.mocked(searchLibraryBooks)

function book(id: number, formats: string[]): BookSearchOption {
  return { id, title: `Book ${id}`, authors: [], seriesName: null, libraryName: 'Books', formats }
}

describe('useLibraryMatchSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    searchMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('searches after a pause and keeps only books holding a file of the format', async () => {
    searchMock.mockResolvedValue([book(1, ['epub']), book(2, ['m4b']), book(3, ['mp3', 'pdf'])])
    const search = useLibraryMatchSearch(ref<MonitoredFormat>('audiobook'))

    search.query.value = 'Shadows'
    await vi.advanceTimersByTimeAsync(300)

    expect(searchMock).toHaveBeenCalledTimes(1)
    expect(searchMock.mock.calls[0]![0]).toBe('Shadows')
    expect(search.results.value.map((found) => found.id)).toEqual([2, 3])
  })

  it('says when the result cap dropped books of the other format', async () => {
    searchMock.mockResolvedValue(Array.from({ length: 20 }, (_, index) => book(index + 1, index === 0 ? ['m4b'] : ['epub'])))
    const search = useLibraryMatchSearch(ref<MonitoredFormat>('audiobook'))

    search.query.value = 'Shadows'
    await vi.advanceTimersByTimeAsync(300)

    expect(search.results.value.map((found) => found.id)).toEqual([1])
    expect(search.truncated.value).toBe(true)
  })

  it('does not search a query shorter than two letters', async () => {
    const search = useLibraryMatchSearch(ref<MonitoredFormat>('ebook'))

    search.query.value = 'S'
    await vi.advanceTimersByTimeAsync(300)

    expect(searchMock).not.toHaveBeenCalled()
    expect(search.results.value).toEqual([])
  })

  it('reports a failed search', async () => {
    searchMock.mockRejectedValue(new Error('down'))
    const search = useLibraryMatchSearch(ref<MonitoredFormat>('ebook'))

    search.query.value = 'Shadows'
    await vi.advanceTimersByTimeAsync(300)

    expect(search.failed.value).toBe(true)
    expect(search.loading.value).toBe(false)
  })
})
