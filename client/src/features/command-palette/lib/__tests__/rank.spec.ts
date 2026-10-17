// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BookCard } from '@bookorbit/types'
import { matchingAlternativeTitle, rankBooks, rankByRelevance } from '../rank'

function book(id: number, title: string): BookCard {
  return { id, title } as BookCard
}

describe('rankBooks', () => {
  it('puts titles that start with the query ahead of narrator or author matches the server sorted first', () => {
    const books = [book(1, 'Bad Bishop'), book(2, 'Carrie'), book(3, 'King of Ashes'), book(4, 'King Sorrow')]

    expect(rankBooks(books, 'king').map((entry) => entry.id)).toEqual([3, 4, 1, 2])
  })

  it('ranks a word-start match above a match inside a word, and keeps server order within a rank', () => {
    const books = [book(1, 'Unkingly'), book(2, 'The Return of the King'), book(3, 'The Kingdom of Copper')]

    expect(rankBooks(books, 'king').map((entry) => entry.id)).toEqual([2, 3, 1])
  })

  it('matches case-insensitively and leaves the input untouched', () => {
    const books = [book(1, 'Carrie'), book(2, 'KING SORROW')]

    expect(rankBooks(books, '  King ').map((entry) => entry.id)).toEqual([2, 1])
    expect(books.map((entry) => entry.id)).toEqual([1, 2])
  })

  it('returns the books in server order for a blank query', () => {
    const books = [book(1, 'B'), book(2, 'A')]

    expect(rankBooks(books, '   ').map((entry) => entry.id)).toEqual([1, 2])
  })
})

describe('rankByRelevance', () => {
  const rows = [
    { title: 'Eye of the Storm', credits: ['Nam-Hae'] },
    { title: 'Spy x Family', credits: ['Tatsuya Endo', 'Casey Loe'] },
    { title: 'The Loelline Chronicles', credits: [] },
    { title: 'Loen’s Mana Bank', credits: [] },
    { title: 'Plug It In', credits: [] },
  ]
  const rank = (query: string) =>
    rankByRelevance(
      rows,
      query,
      (row) => row.title,
      (row) => row.credits,
    ).map((row) => row.title)

  it('puts title matches first, then credit matches, then the rest in source order', () => {
    expect(rank('loe')).toEqual(['Loen’s Mana Bank', 'The Loelline Chronicles', 'Spy x Family', 'Eye of the Storm', 'Plug It In'])
  })

  it('keeps every row and the source order when nothing matches', () => {
    expect(rank('zzz')).toEqual(rows.map((row) => row.title))
  })
})

it('ranks separated query words as title and credit matches', () => {
  const rows = [
    { title: 'Unrelated', credits: [] },
    { title: 'Lord of Mysteries', credits: [] },
    { title: 'Other', credits: ['Lord of Mysteries'] },
  ]
  expect(
    rankByRelevance(
      rows,
      'lord myst',
      (row) => row.title,
      (row) => row.credits,
    ).map((row) => row.title),
  ).toEqual(['Lord of Mysteries', 'Other', 'Unrelated'])
})
it('ranks alternative titles like titles and folds library titles', () => {
  const rows = [
    { title: 'Unrelated', alt: [] },
    { title: 'Bloom Into You', alt: ['Al final me convertiré en ti'] },
  ]
  expect(
    rankByRelevance(
      rows,
      'final me',
      (row) => row.title,
      () => [],
      (row) => row.alt,
    )[0]?.title,
  ).toBe('Bloom Into You')
  expect(rankBooks([book(1, 'Other'), book(2, 'Étoile')], 'eto')[0]?.id).toBe(2)
})
it('keeps the existing library order for separated ASCII query words', () => {
  expect(rankBooks([book(1, 'Other'), book(2, 'Lord of Mysteries')], 'lord myst').map((row) => row.id)).toEqual([1, 2])
})

describe('matchingAlternativeTitle', () => {
  it('explains a loose source match through the alternative title sharing the most query words', () => {
    expect(matchingAlternativeTitle('Bloom Into You', ['YagaKimi', 'Al final me convertiré en ti'], 'final em')).toBe('Al final me convertiré en ti')
  })

  it('shows nothing when the main title already matches', () => {
    expect(matchingAlternativeTitle('The Final Empire', ['El imperio final'], 'final em')).toBeUndefined()
  })
})
