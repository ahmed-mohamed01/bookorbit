import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { AudioConvertPreviewItem } from '@bookorbit/types'

import { useAudioConvertReview } from '../useAudioConvertReview'

function book(bookId: number, author = 'Craig Alanson', status: AudioConvertPreviewItem['status'] = 'can_convert'): AudioConvertPreviewItem {
  return {
    bookId,
    title: `Book ${bookId}`,
    authors: author ? [author] : [],
    relativeFolder: `${author}/Book ${bookId}`,
    status,
    reason: null,
    fileCount: 1,
    formats: ['mp3'],
    totalBytes: 1000,
    totalDurationSeconds: 60,
    job: null,
  }
}

function setup(items: AudioConvertPreviewItem[], total = items.filter((i) => i.status === 'can_convert').length, search = ref('')) {
  return useAudioConvertReview(ref(items), ref(total), search)
}

describe('useAudioConvertReview', () => {
  it('groups by first author alphabetically, books without an author last', () => {
    const review = setup([book(1, 'Dennis E. Taylor'), book(2, ''), book(3, 'Craig Alanson'), book(4, 'Dennis E. Taylor')])

    expect(review.groups.value.map((g) => g.label)).toEqual(['Craig Alanson', 'Dennis E. Taylor', ''])
    expect(review.groups.value[1]!.items.map((i) => i.bookId)).toEqual([1, 4])
    expect(review.current.value?.bookId).toBe(3)
  })

  it('starts with everything selected and an empty exclusion, counting unloaded books', () => {
    const review = setup([book(1), book(2)], 40)

    expect(review.selectedCount.value).toBe(40)
    expect(review.selectionState.value).toBe('all')
    expect(review.runSelection.value).toEqual({ excludeBookIds: [] })
  })

  it('sends the search with an all-except run so only matching books are queued', () => {
    const review = setup([book(1), book(2)], 2, ref('alanson'))

    expect(review.runSelection.value).toEqual({ excludeBookIds: [], search: 'alanson' })
    review.toggleSelected(book(1))
    expect(review.runSelection.value).toEqual({ excludeBookIds: [1], search: 'alanson' })
    expect(review.selectedCount.value).toBe(1)
  })

  it('names the books for an only run, whatever the search', () => {
    const review = setup([book(1), book(2)], 2, ref('alanson'))
    review.selectNone()
    review.toggleSelected(book(2))

    expect(review.runSelection.value).toEqual({ includeBookIds: [2] })
  })

  it('drops left-out books when the search changes, so the count matches what runs', async () => {
    const search = ref('')
    const review = setup([book(1), book(2), book(3)], 3, search)
    review.toggleSelected(book(1))
    expect(review.selectedCount.value).toBe(2)

    search.value = 'book 2'
    await nextTick()
    expect(review.runSelection.value).toEqual({ excludeBookIds: [], search: 'book 2' })
  })

  it('keeps named books when the search changes', async () => {
    const search = ref('')
    const review = setup([book(1), book(2)], 2, search)
    review.selectNone()
    review.toggleSelected(book(1))

    search.value = 'other'
    await nextTick()
    expect(review.runSelection.value).toEqual({ includeBookIds: [1] })
  })

  it('leaves a book out by excluding it, and includes only marked books after clearing', () => {
    const items = [book(1), book(2), book(3)]
    const review = setup(items)

    review.toggleSelected(items[1]!)
    expect(review.runSelection.value).toEqual({ excludeBookIds: [2] })
    expect(review.selectedCount.value).toBe(2)
    expect(review.selectionState.value).toBe('some')

    review.toggleAll()
    expect(review.selectionState.value).toBe('all')
    review.toggleAll()
    expect(review.selectedCount.value).toBe(0)
    review.toggleSelected(items[0]!)
    expect(review.runSelection.value).toEqual({ includeBookIds: [1] })
  })

  it('never selects books outside the Can convert scope', () => {
    const items = [book(1), book(2, 'Craig Alanson', 'cannot')]
    const review = setup(items)

    expect(review.isSelected(items[1]!)).toBe(false)
    review.toggleSelected(items[1]!)
    expect(review.runSelection.value).toEqual({ excludeBookIds: [] })
  })

  it('toggles a whole author group with a tri-state', () => {
    const items = [book(1, 'A'), book(2, 'A'), book(3, 'B')]
    const review = setup(items)
    const key = review.groups.value[0]!.key

    expect(review.groupState(key)).toBe('all')
    review.toggleGroupSelected(key)
    expect(review.groupState(key)).toBe('none')
    expect(review.runSelection.value).toEqual({ excludeBookIds: [1, 2] })
    review.toggleSelected(items[0]!)
    expect(review.groupState(key)).toBe('some')
  })

  it('steps through visible rows and skips collapsed groups', () => {
    const review = setup([book(1, 'A'), book(2, 'B'), book(3, 'C')])
    review.toggleGroup(review.groups.value[1]!.key)

    review.step(1)
    expect(review.current.value?.bookId).toBe(3)
    review.step(-1)
    expect(review.current.value?.bookId).toBe(1)
  })

  it('ends a run with nothing selected so declined books are not re-armed', () => {
    const review = setup([book(1)])
    review.resetAfterRun()
    expect(review.selectedCount.value).toBe(0)
    expect(review.runSelection.value).toEqual({ includeBookIds: [] })
  })
})
