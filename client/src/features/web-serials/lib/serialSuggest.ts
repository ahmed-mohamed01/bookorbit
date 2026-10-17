import type { WebSerialCatalogEntry, WebSerialSourceOption, WebSerialSuggestion } from '@bookorbit/types'

/** A suggestion the index matched to MangaBaka opens like a series-database result; its details load in the preview. */
export function entryFromSuggestion(suggestion: WebSerialSuggestion & { matchId: string }): WebSerialCatalogEntry {
  return {
    matchId: suggestion.matchId,
    kind: 'novel',
    title: suggestion.title,
    altTitles: [],
    authors: [],
    artists: [],
    year: null,
    status: 'unknown',
    genres: [],
    synopsis: null,
    coverUrl: suggestion.cover,
    url: `https://mangabaka.org/${suggestion.matchId}`,
    inLibrary: false,
  }
}

export const SUGGESTION_PILL_LIMIT = 3

export interface SuggestionPills {
  names: string[]
  more: number
}

/** One pill per site (a site with several copies counts once); the rest collapse into a "+N". */
export function suggestionPills(suggestion: WebSerialSuggestion): SuggestionPills {
  const names = [...new Set(suggestion.entries.map((entry) => entry.sourceName))]
  return { names: names.slice(0, SUGGESTION_PILL_LIMIT), more: Math.max(0, names.length - SUGGESTION_PILL_LIMIT) }
}

/** A choice from the box lists every copy as a download alternative; the counts are filled in lazily. */
export function optionsFromSuggestion(suggestion: WebSerialSuggestion): WebSerialSourceOption[] {
  return suggestion.entries.map((entry) => ({
    seriesKey: entry.seriesKey,
    sourceName: entry.sourceName,
    title: suggestion.title,
    chapterCount: 0,
    chaptersUnknown: true,
    latestAt: null,
    confidence: 'same_series',
    mostComplete: false,
    ...(entry.mtl ? { mtl: true } : {}),
  }))
}

/** A copy that is not a machine translation first, then the one with the most chapters when known, else the first listed. */
export function preselectedOption(options: readonly WebSerialSourceOption[]): WebSerialSourceOption | null {
  const pool = options.some((option) => !option.mtl) ? options.filter((option) => !option.mtl) : options
  let best: WebSerialSourceOption | null = null
  for (const option of pool) {
    if (best === null || (!option.chaptersUnknown && (best.chaptersUnknown || option.chapterCount > best.chapterCount))) best = option
  }
  return best
}

export function suggestionOptionId(index: number): string {
  return `web-serials-suggestion-${index}`
}
