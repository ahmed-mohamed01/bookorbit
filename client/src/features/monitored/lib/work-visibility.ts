import type { MonitoredWork } from '@bookorbit/types'
import { releaseDateForWork } from './grouping'
import { parseMonitoredDate } from './release-date'

/** Mirrors the server predicate: what the default list holds with nothing extra switched on. */
export function isWorkVisible(work: MonitoredWork): boolean {
  if (work.userVisibility === 'hidden') return false
  if (work.userVisibility === 'visible') return true
  return work.verdict === 'verified' && work.flags.length === 0
}

export const MONITORED_REVIEW_KINDS = ['collection', 'anthology', 'graphic_novel', 'format_variant', 'duplicate', 'other'] as const
export type MonitoredReviewKind = (typeof MONITORED_REVIEW_KINDS)[number]

export type MonitoredReviewKindFilter = 'all' | MonitoredReviewKind

export type MonitoredReviewKindCounts = Record<MonitoredReviewKindFilter, number>

/**
 * Which review kinds the list is narrowed to. `all` is a sentinel rather than a materialised list
 * because the kinds an author actually has vary: a selection naming every kind of one author would
 * silently narrow to nothing on the next one.
 */
export type MonitoredReviewKindSelection = 'all' | MonitoredReviewKind[]

export function isReviewKindSelected(selection: MonitoredReviewKindSelection, kind: MonitoredReviewKind): boolean {
  return selection === 'all' || selection.includes(kind)
}

export function isEveryReviewKindSelected(selection: MonitoredReviewKindSelection, present: readonly MonitoredReviewKind[]): boolean {
  return selection === 'all' || present.every((kind) => selection.includes(kind))
}

/**
 * Ticking a kind out of `all` has to spell the sentinel out first, against the kinds on screen, or
 * the click would read as "select only this one" instead of "everything except this one".
 */
export function toggleReviewKind(
  selection: MonitoredReviewKindSelection,
  kind: MonitoredReviewKind,
  present: readonly MonitoredReviewKind[],
): MonitoredReviewKindSelection {
  const current = selection === 'all' ? [...present] : selection
  const next = current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]
  return present.every((entry) => next.includes(entry)) ? 'all' : next
}

/**
 * Which switch in the Display menu governs a work. Every work belongs to exactly one class, so a
 * placeholder is never also counted under review and no toggle can double-count against another.
 */
const MONITORED_DISPLAY_CLASSES = ['default', 'hidden', 'placeholder', 'review'] as const
export type MonitoredDisplayClass = (typeof MONITORED_DISPLAY_CLASSES)[number]

/** How many works each switch would reveal. The default class is the list itself, so it is absent. */
export type MonitoredDisplayClassCounts = Record<Exclude<MonitoredDisplayClass, 'default'>, number>

export function workDisplayClass(work: MonitoredWork): MonitoredDisplayClass {
  if (work.userVisibility === 'hidden') return 'hidden'
  if (isWorkVisible(work)) return 'default'
  return work.flags.includes('placeholder') ? 'placeholder' : 'review'
}

/**
 * A work with neither a date nor a year is `undated`, and the released/upcoming switches leave it
 * alone: it is not evidence of either, and dropping it would silently swallow every unannounced
 * book in the catalog.
 */
export type MonitoredWorkReleaseStatus = 'released' | 'upcoming' | 'undated'

export function workReleaseStatus(work: MonitoredWork, now: number = Date.now()): MonitoredWorkReleaseStatus {
  const parsed = parseMonitoredDate(releaseDateForWork(work))
  if (!parsed) return 'undated'
  return parsed.date.getTime() > now ? 'upcoming' : 'released'
}

/**
 * The chip a review work answers to. Only slot resolution names a kind, so a work that reached the
 * tray on its verdict alone - too obscure to corroborate, or flagged - falls to `other`.
 */
export function reviewKindOf(work: MonitoredWork): MonitoredReviewKind {
  return work.kind ?? 'other'
}

export function countReviewKinds(works: MonitoredWork[]): MonitoredReviewKindCounts {
  const counts: MonitoredReviewKindCounts = { all: 0, collection: 0, anthology: 0, graphic_novel: 0, format_variant: 0, duplicate: 0, other: 0 }
  for (const work of works) {
    counts.all += 1
    counts[reviewKindOf(work)] += 1
  }
  return counts
}

export interface MonitoredDisplayOptions {
  released: boolean
  upcoming: boolean
  hidden: boolean
  placeholders: boolean
  review: boolean
  reviewKinds: MonitoredReviewKindSelection
}

export const DEFAULT_MONITORED_DISPLAY: MonitoredDisplayOptions = {
  released: true,
  upcoming: true,
  hidden: false,
  placeholders: false,
  review: false,
  reviewKinds: 'all',
}

export function isWorkDisplayed(work: MonitoredWork, display: MonitoredDisplayOptions, now: number = Date.now()): boolean {
  const displayClass = workDisplayClass(work)
  if (displayClass === 'hidden' && !display.hidden) return false
  if (displayClass === 'placeholder' && !display.placeholders) return false
  if (displayClass === 'review') {
    if (!display.review) return false
    if (!isReviewKindSelected(display.reviewKinds, reviewKindOf(work))) return false
  }
  const status = workReleaseStatus(work, now)
  if (status === 'released' && !display.released) return false
  if (status === 'upcoming' && !display.upcoming) return false
  return true
}

export function isDefaultDisplay(display: MonitoredDisplayOptions): boolean {
  return (Object.keys(DEFAULT_MONITORED_DISPLAY) as (keyof MonitoredDisplayOptions)[]).every((key) => display[key] === DEFAULT_MONITORED_DISPLAY[key])
}

export function readDisplayOptions(stored: unknown): MonitoredDisplayOptions {
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_MONITORED_DISPLAY }
  const raw = stored as Partial<Record<keyof MonitoredDisplayOptions, unknown>>
  const flag = (key: keyof MonitoredDisplayOptions): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : (DEFAULT_MONITORED_DISPLAY[key] as boolean)
  // A stored selection is filtered rather than trusted: the vocabulary can shrink between releases,
  // and an unrecognised entry would narrow the list to nothing with no way to see why.
  const storedKinds = raw.reviewKinds
  const kinds = Array.isArray(storedKinds)
    ? storedKinds.filter((entry): entry is MonitoredReviewKind => (MONITORED_REVIEW_KINDS as readonly unknown[]).includes(entry))
    : null
  return {
    released: flag('released'),
    upcoming: flag('upcoming'),
    hidden: flag('hidden'),
    placeholders: flag('placeholders'),
    review: flag('review'),
    reviewKinds: kinds && kinds.length > 0 ? kinds : 'all',
  }
}
