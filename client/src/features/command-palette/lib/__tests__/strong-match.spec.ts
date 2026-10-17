import { describe, it, expect } from 'vitest'
import type { BookCard, AuthorSummary } from '@bookorbit/types'
import { countStrongMatches } from '../strong-match'
const book = (id: number, title = 'Mistborn: The Final Empire') => ({ id, title, authors: ['Brandon Sanderson'] }) as BookCard
const count = (q: string, books = [book(1)], authors: AuthorSummary[] = []) => countStrongMatches(q, { books, authors, series: [], watchlist: [] })
describe('strong matches', () => {
  it('does not match null titles as text', () => {
    expect(count('nul', [{ ...book(1), title: null }])).toBe(0)
  })
  it('folds letters without combining forms', () => {
    expect(count('lodz', [book(1, 'Łódź')])).toBe(1)
  })
  it('matches word prefixes, not substrings', () => {
    expect(count('fina')).toBe(1)
    expect(count('inal')).toBe(0)
  })
  it('requires every word across title and author', () => {
    expect(count('final empire sanderson')).toBe(1)
    expect(count('final empire king')).toBe(0)
  })
  it('counts formats of one work once', () => {
    expect(count('fina', [book(1), book(2)])).toBe(1)
  })
  it('counts author prefixes as three and folds accents', () => {
    expect(count('sand', [], [{ name: 'Sánderson' } as AuthorSummary])).toBe(3)
  })
})
