import type { BookCard } from '@bookorbit/types'

/**
 * The global book search sorts by title, so "king" opens on "Bad Bishop" because its narrator
 * matched. Within the page already loaded, titles that start with the query come first, then
 * titles containing it as a word, then any title match, then everything else, each in server order.
 */
export function rankBooks(books: readonly BookCard[], query: string): BookCard[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...books]

  function rank(book: BookCard): number {
    return matchTier(book.title ?? '', needle)
  }

  return books
    .map((book, index) => ({ book, index, rank: rank(book) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.book)
}

// Letters NFD does not decompose into a base letter plus a mark, so stripping marks leaves them as is.
const UNDECOMPOSED_LETTERS: Record<string, string> = { ł: 'l', ø: 'o', đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i' }

export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[łøđßæœı]/g, (letter) => UNDECOMPOSED_LETTERS[letter]!)
    .trim()
}

export function searchWords(text: string): string[] {
  return foldSearchText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export function matchTier(text: string, query: string): number {
  const value = foldSearchText(text)
  const needle = foldSearchText(query)
  if (!needle) return 3
  if (value.startsWith(needle)) return 0
  const words = searchWords(value)
  if (words.some((word) => word.startsWith(needle))) return 1
  if (value.includes(needle)) return 2
  return 3
}

function relevanceTier(text: string, query: string): number {
  const tier = matchTier(text, query)
  if (tier < 3) return tier
  const value = foldSearchText(text)
  const words = searchWords(value)
  const needles = searchWords(query)
  if (needles.length && needles.every((part) => words.some((word) => word.startsWith(part)))) return 1
  return needles.length && needles.every((part) => value.includes(part)) ? 2 : 3
}

/** How many query words start a word of the text: a partial match still explains why a source returned a row. */
function wordHits(text: string, query: string): number {
  const words = searchWords(text)
  return searchWords(query).filter((part) => words.some((word) => word.startsWith(part))).length
}

/**
 * The alternative title worth showing as "also known as": the one that matches better than the main
 * title, or, when none ranks better, the one sharing the most query words with it. Sources match
 * loosely (typos, translations), so a partial word match is often the only visible reason a row came back.
 */
export function matchingAlternativeTitle(title: string, alternatives: readonly string[], query: string): string | undefined {
  const mainTier = relevanceTier(title, query)
  let bestTier = mainTier
  let best: string | undefined
  for (const alternative of alternatives) {
    const tier = relevanceTier(alternative, query)
    if (tier < bestTier) {
      bestTier = tier
      best = alternative
    }
  }
  if (best || mainTier < 3) return best
  let bestHits = wordHits(title, query)
  for (const alternative of alternatives) {
    const hits = wordHits(alternative, query)
    if (hits > bestHits) {
      bestHits = hits
      best = alternative
    }
  }
  return best
}

/**
 * Orders an outside source's results the way the palette ranks library titles, keeping the source's
 * own order within a tier: title starts with the query, a title word starts with it, the title
 * contains it, a credit (author, translator) matches, then everything else. Nothing is dropped,
 * because providers may match metadata beyond the titles and credits returned.
 */
export function rankByRelevance<T>(
  items: readonly T[],
  query: string,
  title: (item: T) => string,
  credits: (item: T) => readonly string[] = () => [],
  alternatives: (item: T) => readonly string[] = () => [],
): T[] {
  if (!foldSearchText(query)) return [...items]
  function tier(item: T): number {
    const titleTier = Math.min(relevanceTier(title(item), query), ...alternatives(item).map((text) => relevanceTier(text, query)))
    if (titleTier < 3) return titleTier
    return credits(item).some((credit) => relevanceTier(credit, query) < 3) ? 3 : 4
  }
  return items
    .map((item, index) => ({ item, index, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.item)
}
