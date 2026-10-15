function humanize(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z]+:\s*/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s-])(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase())
}

/** Genres first, then tags; prefixes and underscores dropped, title cased, duplicates removed ignoring case. */
export function cleanTags(genres: readonly string[], tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of [...genres, ...tags]) {
    const tag = humanize(raw)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}
