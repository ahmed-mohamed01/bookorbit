import type { MonitoredGrouping, MonitoredReleaseItem, MonitoredSeriesMembership, MonitoredSort, MonitoredWork } from '@bookorbit/types'

export type MonitoredWorkGroup = {
  key: string
  label: string
  works: MonitoredWork[]
}

export type MonitoredReleaseEntry = {
  id: string
  work: MonitoredWork
  authorName: string
  items: MonitoredReleaseItem[]
}

/**
 * The releases feed carries one row per format, so a work releasing as both ebook and audiobook
 * appears twice. Card surfaces show the work once; fold sibling format rows into one entry,
 * keeping the incoming (already sorted) order by first occurrence.
 */
export function collapseReleaseItems(items: readonly MonitoredReleaseItem[]): MonitoredReleaseEntry[] {
  const byWork = new Map<string, MonitoredReleaseEntry>()
  const entries: MonitoredReleaseEntry[] = []
  for (const item of items) {
    const existing = byWork.get(item.workId)
    if (existing) {
      existing.items.push(item)
      continue
    }
    const entry = { id: item.workId, work: item.work, authorName: item.authorName, items: [item] }
    byWork.set(item.workId, entry)
    entries.push(entry)
  }
  return entries
}

export function releaseDateForWork(work: MonitoredWork): string | null {
  const dates = [work.ebookReleaseDate, work.audioReleaseDate].filter((value): value is string => Boolean(value)).sort()
  return dates[0] ?? (work.releaseYear === null ? null : `${work.releaseYear}-01-01`)
}

export function sortWorks(works: readonly MonitoredWork[], sort: MonitoredSort, order: 'asc' | 'desc'): MonitoredWork[] {
  const direction = order === 'asc' ? 1 : -1
  return [...works].sort((left, right) => {
    if (sort === 'title') return direction * left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
    const leftDate = releaseDateForWork(left)
    const rightDate = releaseDateForWork(right)
    if (leftDate === null && rightDate === null) return left.title.localeCompare(right.title)
    if (leftDate === null) return 1
    if (rightDate === null) return -1
    const comparison = leftDate.localeCompare(rightDate)
    return comparison === 0 ? left.title.localeCompare(right.title) : direction * comparison
  })
}

function pushGroup(groups: Map<string, MonitoredWork[]>, key: string, work: MonitoredWork) {
  const group = groups.get(key)
  if (group) group.push(work)
  else groups.set(key, [work])
}

function isSubset(inner: Set<string>, outer: Set<string>): boolean {
  if (inner.size === 0 || inner.size > outer.size) return false
  for (const id of inner) if (!outer.has(id)) return false
  return true
}

function normalizeSeriesName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bversus\b/g, 'vs')
    .replace(/\s+/g, ' ')
    .trim()
}

export function seriesMembershipForGroup(work: MonitoredWork, groupKey: string): MonitoredSeriesMembership | null {
  if (groupKey === 'standalone') return null
  const normalizedGroup = normalizeSeriesName(groupKey)
  const memberships = work.seriesMemberships ?? []
  return (
    memberships.find((membership) => normalizeSeriesName(membership.name) === normalizedGroup) ??
    memberships.find((membership) => normalizeSeriesName(membership.name).startsWith(`${normalizedGroup} `)) ??
    null
  )
}

/**
 * Comparators run O(n log n) times, so every value they need is resolved once beforehand:
 * membership lookups normalize series names, which is far too costly to repeat per comparison.
 */
function compareSeriesWorks(left: MonitoredWork, right: MonitoredWork, leftIndex: string | null, rightIndex: string | null): number {
  if (leftIndex === null && rightIndex === null) return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  if (leftIndex === null) return 1
  if (rightIndex === null) return -1
  const leftNumber = Number(leftIndex)
  const rightNumber = Number(rightIndex)
  const leftNumeric = Number.isFinite(leftNumber)
  const rightNumeric = Number.isFinite(rightNumber)
  if (leftNumeric && rightNumeric && leftNumber !== rightNumber) return leftNumber - rightNumber
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  const indexComparison = leftIndex.localeCompare(rightIndex, undefined, { numeric: true, sensitivity: 'base' })
  return indexComparison || left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
}

function earliestReleaseDate(works: readonly MonitoredWork[]): string | null {
  return (
    works
      .map(releaseDateForWork)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null
  )
}

export function groupWorks(
  works: readonly MonitoredWork[],
  grouping: MonitoredGrouping,
  order: 'asc' | 'desc',
  sort: MonitoredSort,
): MonitoredWorkGroup[] {
  if (grouping === 'none') return works.length === 0 ? [] : [{ key: 'all', label: 'All books', works: [...works] }]

  if (grouping === 'status') {
    const today = new Date().toISOString().slice(0, 10)
    const recentCutoff = new Date()
    recentCutoff.setFullYear(recentCutoff.getFullYear() - 1)
    const cutoff = recentCutoff.toISOString().slice(0, 10)
    const groups = new Map<string, MonitoredWork[]>([
      ['upcoming', []],
      ['recent', []],
      ['backlist', []],
    ])
    for (const work of works) {
      const date = releaseDateForWork(work)
      const key = date && date > today ? 'upcoming' : date && date >= cutoff ? 'recent' : 'backlist'
      groups.get(key)?.push(work)
    }
    const labels = { upcoming: 'Upcoming', recent: 'Recent', backlist: 'Backlist' }
    return [...groups].flatMap(([key, grouped]) => (grouped.length === 0 ? [] : [{ key, label: labels[key as keyof typeof labels], works: grouped }]))
  }

  const groups = new Map<string, MonitoredWork[]>()
  if (grouping === 'series') {
    // Group by Hardcover's FEATURED series (one canonical primary per book), then fan the remaining
    // memberships out so cross-cutting meta-series (e.g. The Cosmere) get their own sections. This is
    // what stops Hardcover's overlapping names ("The Mistborn Trilogy", "Mistborn", ...) from
    // fragmenting one series into many phantom groups.
    const groupKeys = new Map<string, string>() // normalized name -> canonical display key
    const memberIds = new Map<string, Set<string>>() // display key -> ids of works in the group
    const featuredKeys = new Set<string>() // display keys that are a primary (featured) section

    const canonicalKey = (rawName: string): string | null => {
      const name = rawName.trim()
      const normalized = normalizeSeriesName(name)
      if (!normalized) return null
      const existing = groupKeys.get(normalized)
      if (existing) return existing
      groupKeys.set(normalized, name)
      return name
    }
    const addToGroup = (rawName: string, work: MonitoredWork, isFeatured: boolean): void => {
      const key = canonicalKey(rawName)
      if (!key) return
      let bucket = groups.get(key)
      let ids = memberIds.get(key)
      if (!bucket || !ids) {
        bucket = []
        ids = new Set()
        groups.set(key, bucket)
        memberIds.set(key, ids)
      }
      if (isFeatured) featuredKeys.add(key)
      if (!ids.has(work.id)) {
        ids.add(work.id)
        bucket.push(work)
      }
    }

    for (const work of works) {
      const primaryName = work.seriesName?.trim() || work.seriesMemberships?.[0]?.name?.trim() || null
      const primaryKey = primaryName ? canonicalKey(primaryName) : null
      if (primaryName && primaryKey) addToGroup(primaryName, work, true)
      else pushGroup(groups, 'standalone', work)
      for (const membership of work.seriesMemberships ?? []) {
        const key = canonicalKey(membership.name)
        if (!key || key === primaryKey) continue
        addToGroup(membership.name, work, false)
      }
    }

    // Drop fan-out sections that merely rename or subset a featured section; keep meta-series that
    // span multiple featured sections (e.g. The Cosmere, the master Mistborn Saga).
    const featuredSets = [...featuredKeys].map((key) => memberIds.get(key)).filter((set): set is Set<string> => Boolean(set))
    for (const [key, ids] of memberIds) {
      if (featuredKeys.has(key)) continue
      if (featuredSets.some((set) => set !== ids && isSubset(ids, set))) groups.delete(key)
    }

    // Fold a variant meta-series into its base spelling ("The Cosmere Universe" -> "The Cosmere") when
    // one surviving group's name is a word-prefix of another and the base group is at least as large.
    const foldCandidates = [...groups.keys()]
    for (const keyB of foldCandidates) {
      const worksB = groups.get(keyB)
      const idsB = memberIds.get(keyB)
      if (!worksB || !idsB) continue
      const normalizedB = normalizeSeriesName(keyB)
      const baseKey = [...groups.keys()].find((keyA) => {
        if (keyA === keyB) return false
        const idsA = memberIds.get(keyA)
        return idsA != null && idsA.size >= idsB.size && normalizedB.startsWith(`${normalizeSeriesName(keyA)} `)
      })
      const worksA = baseKey ? groups.get(baseKey) : undefined
      const idsA = baseKey ? memberIds.get(baseKey) : undefined
      if (!worksA || !idsA) continue
      for (const work of worksB) {
        if (!idsA.has(work.id)) {
          idsA.add(work.id)
          worksA.push(work)
        }
      }
      groups.delete(keyB)
    }
  } else {
    for (const work of works) pushGroup(groups, String(work.releaseYear ?? 'unknown'), work)
  }

  const direction = order === 'asc' ? 1 : -1
  const entries = [...groups.entries()]
  const earliestDates = new Map(entries.map(([key, grouped]) => [key, earliestReleaseDate(grouped)]))
  entries.sort(([leftKey], [rightKey]) => {
    if (grouping === 'series') {
      if (leftKey === 'standalone') return 1
      if (rightKey === 'standalone') return -1
      // Order the series sections by the active sort: alphabetically by series name for title sort,
      // otherwise by each series' earliest release date. Both honour the ascending/descending toggle.
      if (sort === 'title') return direction * leftKey.localeCompare(rightKey, undefined, { sensitivity: 'base' })
      const leftDate = earliestDates.get(leftKey) ?? null
      const rightDate = earliestDates.get(rightKey) ?? null
      if (leftDate === null && rightDate === null) return leftKey.localeCompare(rightKey, undefined, { sensitivity: 'base' })
      if (leftDate === null) return 1
      if (rightDate === null) return -1
      const comparison = leftDate.localeCompare(rightDate)
      return comparison === 0 ? leftKey.localeCompare(rightKey) : direction * comparison
    }
    if (leftKey === 'unknown') return 1
    if (rightKey === 'unknown') return -1
    return direction * leftKey.localeCompare(rightKey)
  })

  return entries.map(([key, grouped]) => {
    if (grouping === 'series' && key !== 'standalone') {
      // Within a series, books always read in index order; the sort/order toggle reorders the sections.
      const indexes = new Map(grouped.map((work) => [work.id, seriesMembershipForGroup(work, key)?.index ?? null]))
      return {
        key,
        label: key,
        works: [...grouped].sort((left, right) => compareSeriesWorks(left, right, indexes.get(left.id) ?? null, indexes.get(right.id) ?? null)),
      }
    }
    return {
      key,
      label: key === 'standalone' ? 'Standalone' : key === 'unknown' ? 'Unknown year' : key,
      works: [...grouped],
    }
  })
}
