import type { AuthorSummary, BookCard, MonitoredCatalogSearchHit, SeriesSummary } from '@bookorbit/types'
import { foldSearchText, matchTier, searchWords } from './rank'

export function countStrongMatches(
  query: string,
  input: {
    books: readonly BookCard[]
    authors: readonly AuthorSummary[]
    series: readonly SeriesSummary[]
    watchlist: readonly MonitoredCatalogSearchHit[]
  },
): number {
  const words = searchWords(query)
  if (!words.length) return 0
  const strong = (text: string) => words.every((word) => matchTier(text, word) < 2)
  if (input.authors.some((author) => strong(author.name)) || input.series.some((series) => strong(series.name))) return 3
  const keys = new Set<string>()
  for (const book of input.books) {
    if (strong(`${book.title ?? ''} ${book.authors.join(' ')}`) || (words.length === 1 && strong(book.seriesName ?? ''))) {
      keys.add(`${foldSearchText(book.title ?? '')}:${foldSearchText(book.authors[0] ?? '')}`)
    }
  }
  const works = new Set<string>()
  for (const hit of input.watchlist) {
    if (strong(`${hit.work.title ?? ''} ${hit.authorName}`) || (words.length === 1 && strong(hit.work.seriesName ?? ''))) works.add(hit.work.id)
  }
  return keys.size + works.size
}
