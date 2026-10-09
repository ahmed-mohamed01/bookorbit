import { describe, expect, it } from 'vitest'
import type { CurrentlyReadingBook } from '@bookorbit/types'
import { editionStackBadgeStyle, editionStackLayout, stackCurrentlyReading } from './currently-reading-stacks'

function book(bookId: number, overrides: Partial<CurrentlyReadingBook> = {}): CurrentlyReadingBook {
  return {
    bookId,
    title: `Book ${bookId}`,
    authors: [],
    progress: 10,
    hasCover: true,
    fileId: bookId * 10,
    fileFormat: 'epub',
    readFileId: bookId * 10,
    readFileFormat: 'epub',
    readAlongFileId: null,
    hasAudio: false,
    ...overrides,
  }
}

function ids(books: readonly CurrentlyReadingBook[]): number[] {
  return books.map((entry) => entry.bookId)
}

describe('stackCurrentlyReading', () => {
  it('returns no stacks for an empty list', () => {
    expect(stackCurrentlyReading([])).toEqual([])
  })

  it('keeps books without an edition group as their own stacks', () => {
    const stacks = stackCurrentlyReading([book(1), book(2, { editionGroupId: null })])

    expect(stacks.map((stack) => stack.lead.bookId)).toEqual([1, 2])
    expect(stacks.map((stack) => ids(stack.editions))).toEqual([[1], [2]])
  })

  it('merges books sharing an edition group into one stack at the first member position', () => {
    const stacks = stackCurrentlyReading([
      book(1),
      book(2, { editionGroupId: 7 }),
      book(3),
      book(4, { editionGroupId: 7 }),
      book(5, { editionGroupId: 8 }),
    ])

    expect(stacks.map((stack) => ids(stack.editions))).toEqual([[1], [2, 4], [3], [5]])
  })

  it('leads with the edition that has the latest activity and lists the rest in list order', () => {
    const stacks = stackCurrentlyReading([
      book(1, { editionGroupId: 7, lastActivityAt: '2026-10-01T10:00:00Z' }),
      book(2, { editionGroupId: 7, lastActivityAt: '2026-10-01T09:00:00Z' }),
      book(3, { editionGroupId: 7, lastActivityAt: '2026-10-03T10:00:00Z' }),
    ])

    expect(stacks).toHaveLength(1)
    expect(stacks[0]!.lead.bookId).toBe(3)
    expect(ids(stacks[0]!.editions)).toEqual([3, 1, 2])
  })

  it('treats null, missing and unparseable activity as oldest', () => {
    const stacks = stackCurrentlyReading([
      book(1, { editionGroupId: 7, lastActivityAt: null }),
      book(2, { editionGroupId: 7 }),
      book(3, { editionGroupId: 7, lastActivityAt: 'not a date' }),
      book(4, { editionGroupId: 7, lastActivityAt: '2020-01-01T00:00:00Z' }),
    ])

    expect(stacks[0]!.lead.bookId).toBe(4)
    expect(ids(stacks[0]!.editions)).toEqual([4, 1, 2, 3])
  })

  it('falls back to list order when no member has activity', () => {
    const stacks = stackCurrentlyReading([book(1, { editionGroupId: 7, lastActivityAt: null }), book(2, { editionGroupId: 7 })])

    expect(stacks[0]!.lead.bookId).toBe(1)
    expect(ids(stacks[0]!.editions)).toEqual([1, 2])
  })

  it('lets the earlier member win a tie on activity', () => {
    const stacks = stackCurrentlyReading([
      book(1, { editionGroupId: 7, lastActivityAt: '2026-10-01T09:00:00Z' }),
      book(2, { editionGroupId: 7, lastActivityAt: '2026-10-02T09:00:00Z' }),
      book(3, { editionGroupId: 7, lastActivityAt: '2026-10-02T09:00:00.000Z' }),
    ])

    expect(stacks[0]!.lead.bookId).toBe(2)
    expect(ids(stacks[0]!.editions)).toEqual([2, 1, 3])
  })
})

describe('editionStackLayout', () => {
  it('gives a lone cover the whole slot', () => {
    expect(editionStackLayout(1)).toEqual([{ left: '0%', width: '100%', bottom: '0%', height: '100%', zIndex: 3 }])
  })

  it('keeps the lead in front and pushes each edition behind it up and to the left as a same-size card', () => {
    const layout = editionStackLayout(3)

    expect(layout.map((slot) => [slot.left, slot.bottom])).toEqual([
      ['0%', '0%'],
      ['-8%', '12%'],
      ['-16%', '24%'],
    ])
    expect(layout.every((slot) => slot.width === '100%' && slot.height === '76%')).toBe(true)
    expect(layout.map((slot) => slot.zIndex)).toEqual([3, 2, 1])
  })

  it('shows at most three covers and nothing for an empty stack', () => {
    expect(editionStackLayout(5)).toHaveLength(3)
    expect(editionStackLayout(0)).toEqual([])
  })
})

describe('editionStackBadgeStyle', () => {
  it("sits just inside the rearmost card's top-left corner", () => {
    expect(editionStackBadgeStyle(3)).toEqual({ left: 'calc(-16% + 1px)', top: '1px' })
    expect(editionStackBadgeStyle(2)).toEqual({ left: 'calc(-8% + 1px)', top: '1px' })
  })

  it('never reaches past the three visible cards', () => {
    expect(editionStackBadgeStyle(6)).toEqual(editionStackBadgeStyle(3))
    expect(editionStackBadgeStyle(0)).toEqual({ left: 'calc(0% + 1px)', top: '1px' })
  })
})
