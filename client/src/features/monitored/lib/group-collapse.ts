/**
 * Which sections a reader has collapsed, remembered per monitored author. Series sets differ from
 * one author to the next, so a single shared flag would either collapse catalogs nobody asked about
 * or forget the one the reader just tidied.
 */
export type MonitoredCollapseEntry = {
  /** What a section the reader has never touched does, so collapse-all covers later arrivals too. */
  all: boolean
  /** Only the sections that disagree with `all`, keeping the record as small as the choices made. */
  groups: Record<string, boolean>
}

export type MonitoredCollapseStore = Record<string, MonitoredCollapseEntry>

export function emptyCollapseEntry(): MonitoredCollapseEntry {
  return { all: false, groups: {} }
}

/** Authors are monitored in bulk, so the record is capped and the least recently touched fall off. */
export const MONITORED_COLLAPSE_AUTHOR_LIMIT = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Section keys carry series names, which are provider data. They are collected into the record by
 * `fromEntries` rather than assigned key by key, so a series named `__proto__` becomes an ordinary
 * entry instead of rewriting the prototype of the record it lands in.
 */
export function readCollapseStore(stored: unknown): MonitoredCollapseStore {
  if (!isRecord(stored)) return {}
  const entries: [string, MonitoredCollapseEntry][] = []
  for (const [authorId, raw] of Object.entries(stored)) {
    if (!isRecord(raw)) continue
    const groups = isRecord(raw.groups) ? Object.entries(raw.groups).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean') : []
    entries.push([authorId, { all: raw.all === true, groups: Object.fromEntries(groups) }])
  }
  return Object.fromEntries(entries)
}

export function collapseEntryFor(store: MonitoredCollapseStore, authorId: string): MonitoredCollapseEntry {
  const entry = store[authorId]
  return entry ? { all: entry.all, groups: { ...entry.groups } } : emptyCollapseEntry()
}

/**
 * Rewrites the author's entry at the end of the record so insertion order doubles as recency, then
 * trims the oldest past the cap. An entry back at its default holds nothing worth remembering.
 */
export function writeCollapseEntry(
  store: MonitoredCollapseStore,
  authorId: string,
  entry: MonitoredCollapseEntry,
  limit = MONITORED_COLLAPSE_AUTHOR_LIMIT,
): MonitoredCollapseStore {
  const kept = Object.entries(store).filter(([key]) => key !== authorId)
  if (entry.all || Object.keys(entry.groups).length > 0) kept.push([authorId, entry])
  return Object.fromEntries(kept.slice(Math.max(0, kept.length - limit)))
}
