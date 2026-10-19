import {
  isDefaultClassSelection,
  workDisplayClass,
  workKindOf,
  isWorkListed,
  isWorkVisible,
  workMatchesClassSelection,
  MONITORED_REVIEW_FLAGS,
  MONITORED_MARK_KINDS,
  type MonitoredClassSelection,
  type MonitoredMarkKind,
  type MonitoredWork,
} from '@bookorbit/types'
import { releaseDateForWork } from './grouping'
import { parseMonitoredDate } from './release-date'
import { toggleInOrder } from './toggle-in-order'

export {
  isWorkVisible,
  workKindOf,
  workDisplayClass,
  isWorkUnconfirmed,
  countWorkClasses,
  type MonitoredDisplayClass,
  type MonitoredDisplayClassCounts,
} from '@bookorbit/types'

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
  const ownedBypass = display.kinds.includes('book') && isWorkListed(work) && !isWorkVisible(work)
  if (!ownedBypass && !workMatchesClassSelection(work, toClassSelection(display))) return false
  const status = workReleaseStatus(work, now)
  return !(status === 'released' && !display.released) && !(status === 'upcoming' && !display.upcoming)
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

export function toClassSelection(display: MonitoredDisplayOptions): MonitoredClassSelection {
  return { kinds: [...display.kinds], more: MONITORED_REVIEW_FLAGS.filter((flag) => display[flag]) }
}

/** The releases tab keeps only the class half of the display options; released/upcoming are fixed there. */
export function toReleaseDisplay(selection: MonitoredClassSelection): MonitoredDisplayOptions {
  return {
    released: true,
    upcoming: true,
    kinds: [...selection.kinds],
    hidden: selection.more.includes('hidden'),
    placeholders: selection.more.includes('placeholders'),
    unconfirmed: selection.more.includes('unconfirmed'),
  }
}

export function readClassSelection(stored: unknown): MonitoredClassSelection {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const kinds = MONITORED_MARK_KINDS.filter((kind) => Array.isArray(raw.kinds) && raw.kinds.includes(kind))
  const more = MONITORED_REVIEW_FLAGS.filter((flag) => Array.isArray(raw.more) && raw.more.includes(flag))
  return { kinds: kinds.length || (Array.isArray(raw.kinds) && raw.kinds.length === 0) ? kinds : ['book'], more }
}

export function workClassChanged(before: MonitoredWork | null, after: MonitoredWork): boolean {
  return before !== null && (workDisplayClass(before) !== workDisplayClass(after) || workKindOf(before) !== workKindOf(after))
}

/** A row leaves the review queue when its class changes, so only a non-default selection needs the reload. */
export function classChangeLeavesQueue(before: MonitoredWork | null, after: MonitoredWork, selection: MonitoredClassSelection): boolean {
  return workClassChanged(before, after) && !isDefaultClassSelection(selection)
}
