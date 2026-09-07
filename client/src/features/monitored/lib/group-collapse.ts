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

export function readCollapseStore(stored: unknown): MonitoredCollapseStore {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const store: MonitoredCollapseStore = {}
  for (const [authorId, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Partial<Record<keyof MonitoredCollapseEntry, unknown>>
    const groups: Record<string, boolean> = {}
    if (typeof entry.groups === 'object' && entry.groups !== null && !Array.isArray(entry.groups)) {
      for (const [key, value] of Object.entries(entry.groups as Record<string, unknown>)) {
        if (typeof value === 'boolean') groups[key] = value
      }
    }
    store[authorId] = { all: entry.all === true, groups }
  }
  return store
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
  const next: MonitoredCollapseStore = {}
  for (const [key, value] of Object.entries(store)) {
    if (key !== authorId) next[key] = value
  }
  if (entry.all || Object.keys(entry.groups).length > 0) next[authorId] = entry
  const authorIds = Object.keys(next)
  if (authorIds.length <= limit) return next
  for (const stale of authorIds.slice(0, authorIds.length - limit)) delete next[stale]
  return next
}
