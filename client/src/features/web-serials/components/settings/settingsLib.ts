import type { Library, WebSerialKind, WebSerialMangaSource, WebSerialNovelSource } from '@bookorbit/types'

const KIND_FORMAT: Record<WebSerialKind, string> = { manga: 'cbz', novel: 'epub' }
const SOURCE_LANGUAGE_SUFFIX = /\s*\([A-Za-z0-9-]{2,8}\)\s*$/
export const NOVEL_CHIPS_COLLAPSED = 24

export interface MangaLanguageGroup {
  lang: string
  sources: WebSerialMangaSource[]
  ids: string[]
}

/** An empty list means the library takes every format. */
export function libraryAcceptsKind(library: Pick<Library, 'allowedFormats'>, kind: WebSerialKind): boolean {
  return !library.allowedFormats?.length || library.allowedFormats.includes(KIND_FORMAT[kind])
}

export function cleanSourceName(displayName: string): string {
  return displayName.replace(SOURCE_LANGUAGE_SUFFIX, '').trim() || displayName
}

export function groupSourcesByLanguage(sources: readonly WebSerialMangaSource[]): MangaLanguageGroup[] {
  const groups = new Map<string, WebSerialMangaSource[]>()
  for (const source of sources) {
    const lang = source.lang.toLowerCase()
    groups.set(lang, [...(groups.get(lang) ?? []), source])
  }
  return [...groups.entries()]
    .map(([lang, items]) => ({ lang, sources: items, ids: items.map((item) => item.id) }))
    .sort((a, b) => a.lang.localeCompare(b.lang))
}

function baseLanguage(lang: string): string {
  return lang.split('-', 1)[0] ?? lang
}

/** The server also matches a regional source against its base language, so the picker has to agree. */
export function isLanguageSelected(selected: readonly string[], lang: string): boolean {
  const code = lang.toLowerCase()
  return selected.includes(code) || selected.includes(baseLanguage(code))
}

/** Sources the server searches: the picked ids, or every installed source in the chosen languages while nothing was picked. */
export function effectiveSourceIds(
  sources: readonly WebSerialMangaSource[],
  sourceIds: readonly string[] | null,
  languages: readonly string[],
): string[] {
  if (sourceIds) return [...sourceIds]
  return sources.filter((source) => isLanguageSelected(languages, source.lang)).map((source) => source.id)
}

export function toggleSource(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
}

export function setSourcesSelected(selected: readonly string[], ids: readonly string[], on: boolean): string[] {
  const group = new Set(ids)
  const rest = selected.filter((value) => !group.has(value))
  return on ? [...rest, ...ids] : rest
}

export function languageName(lang: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(lang) ?? lang.toUpperCase()
  } catch {
    return lang.toUpperCase()
  }
}

export function searchableDomains(sources: readonly WebSerialNovelSource[]): string[] {
  return sources.filter((source) => source.canSearch && !source.disabled).map((source) => source.domain)
}

/** Selected sites lead, so what is searched is visible without scrolling; the rest keep their alphabetical order. */
export function orderedDomains(domains: readonly string[], selected: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  const chosen = new Set(selected)
  const matching = domains.filter((domain) => domain.includes(needle))
  return [...matching.filter((domain) => chosen.has(domain)), ...matching.filter((domain) => !chosen.has(domain))]
}

export function toggleDomain(selected: readonly string[], domain: string): string[] {
  return selected.includes(domain) ? selected.filter((value) => value !== domain) : [...selected, domain]
}
