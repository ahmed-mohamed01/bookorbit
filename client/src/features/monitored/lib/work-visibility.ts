import { isWorkVisible, MONITORED_MARK_KINDS, type MonitoredMarkKind, type MonitoredWork } from '@bookorbit/types'
import { releaseDateForWork } from './grouping'
import { parseMonitoredDate } from './release-date'
import { toggleInOrder } from './toggle-in-order'

export { isWorkVisible }

export function workKindOf(work: MonitoredWork): MonitoredMarkKind | null {
  return work.userKind ?? (isWorkVisible(work) ? 'book' : (work.kind ?? null))
}

export type MonitoredDisplayClass = 'hidden' | 'kind' | 'placeholder' | 'unconfirmed'
export interface MonitoredDisplayClassCounts {
  hidden: number
  placeholder: number
  unconfirmed: number
  kinds: Record<MonitoredMarkKind, number>
}

export function workDisplayClass(work: MonitoredWork): MonitoredDisplayClass {
  if (work.userVisibility === 'hidden') return 'hidden'
  // A placeholder the owner kept or marked Book is on the default list, so only an automatic one is a placeholder here.
  if (!isWorkVisible(work) && work.flags.includes('placeholder')) return 'placeholder'
  return workKindOf(work) !== null ? 'kind' : 'unconfirmed'
}

export function isWorkUnconfirmed(work: MonitoredWork): boolean {
  return (
    work.userVisibility !== 'hidden' &&
    !work.userKind &&
    work.userVisibility !== 'visible' &&
    !work.flags.includes('placeholder') &&
    (work.verdict !== 'verified' || work.flags.length > 0)
  )
}

// A work with neither date nor year is undated, and the released/upcoming switches leave it alone:
// it is evidence of neither, and dropping it would silently swallow every unannounced book.
export type MonitoredWorkReleaseStatus = 'released' | 'upcoming' | 'undated'

export function workReleaseStatus(work: MonitoredWork, now: number = Date.now()): MonitoredWorkReleaseStatus {
  const parsed = parseMonitoredDate(releaseDateForWork(work))
  if (!parsed) return 'undated'
  return parsed.date.getTime() > now ? 'upcoming' : 'released'
}

export type MonitoredDisplayFlag = 'released' | 'upcoming' | 'hidden' | 'placeholders' | 'unconfirmed'

export interface MonitoredDisplayOptions {
  released: boolean
  upcoming: boolean
  kinds: MonitoredMarkKind[]
  hidden: boolean
  placeholders: boolean
  unconfirmed: boolean
}

export const DEFAULT_MONITORED_DISPLAY: MonitoredDisplayOptions = {
  released: true,
  upcoming: true,
  kinds: ['book'],
  hidden: false,
  placeholders: false,
  unconfirmed: false,
}

export function isWorkDisplayed(work: MonitoredWork, display: MonitoredDisplayOptions, now: number = Date.now()): boolean {
  const displayClass = workDisplayClass(work)
  if (displayClass === 'hidden' && !display.hidden) return false
  if (displayClass === 'placeholder' && !display.placeholders) return false
  if (displayClass !== 'hidden' && displayClass !== 'placeholder') {
    const kind = workKindOf(work)
    if (!(kind !== null && display.kinds.includes(kind)) && !(display.unconfirmed && isWorkUnconfirmed(work))) return false
  }
  const status = workReleaseStatus(work, now)
  return !(status === 'released' && !display.released) && !(status === 'upcoming' && !display.upcoming)
}

export function countWorkClasses(works: MonitoredWork[]): MonitoredDisplayClassCounts {
  const counts: MonitoredDisplayClassCounts = {
    hidden: 0,
    placeholder: 0,
    unconfirmed: 0,
    kinds: Object.fromEntries(MONITORED_MARK_KINDS.map((kind) => [kind, 0])) as Record<MonitoredMarkKind, number>,
  }
  for (const work of works) {
    const category = workDisplayClass(work)
    if (category === 'kind') counts.kinds[workKindOf(work)!] += 1
    else if (category !== 'unconfirmed') counts[category] += 1
    if (isWorkUnconfirmed(work)) counts.unconfirmed += 1
  }
  return counts
}

export function toggleKind(selection: readonly MonitoredMarkKind[], kind: MonitoredMarkKind): MonitoredMarkKind[] {
  return toggleInOrder(MONITORED_MARK_KINDS, selection, kind)
}

export function isDefaultDisplay(display: MonitoredDisplayOptions): boolean {
  return (
    display.released &&
    display.upcoming &&
    !display.hidden &&
    !display.placeholders &&
    !display.unconfirmed &&
    display.kinds.length === 1 &&
    display.kinds[0] === 'book'
  )
}

export function readDisplayOptions(stored: unknown): MonitoredDisplayOptions {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const flag = (key: MonitoredDisplayFlag) => (typeof raw[key] === 'boolean' ? (raw[key] as boolean) : DEFAULT_MONITORED_DISPLAY[key])
  // The stored kind selection is filtered rather than trusted: the vocabulary can change between
  // releases, and an unknown entry would narrow the list with no way to see why.
  const kinds = MONITORED_MARK_KINDS.filter((kind) => Array.isArray(raw.kinds) && raw.kinds.includes(kind))
  return {
    released: flag('released'),
    upcoming: flag('upcoming'),
    hidden: flag('hidden'),
    placeholders: flag('placeholders'),
    unconfirmed: flag('unconfirmed'),
    kinds: kinds.length || (Array.isArray(raw.kinds) && raw.kinds.length === 0) ? kinds : ['book'],
  }
}
