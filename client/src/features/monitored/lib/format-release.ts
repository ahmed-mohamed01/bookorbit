import type {
  MonitoredDatePrecision,
  MonitoredFormat,
  MonitoredFormatRelease,
  MonitoredReleaseDateSource,
  MonitoredSuggestedReleaseDate,
  MonitoredWork,
} from '@bookorbit/types'
import { monitoredReleaseWindowStarted } from './release-date'

/**
 * What one format of a work is doing, in the terms a reader needs: `unlisted` is a source saying
 * this format does not exist yet, while `unknown` is nobody having looked. Collapsing the two would
 * put an ebook on sale off the back of an audiobook date, which is the thing the probe exists to
 * stop.
 */
export type MonitoredFormatReleaseKind = 'owned' | 'released' | 'upcoming' | 'expected' | 'unlisted' | 'unknown'

export interface MonitoredFormatReleaseState {
  kind: MonitoredFormatReleaseKind
  date: string | null
  precision: MonitoredDatePrecision | null
  source: MonitoredReleaseDateSource | null
  checkedAt: string | null
  /** When the shown date last took a new value, and what it moved from; null when the date is not the probe's. */
  changedAt: string | null
  previousDate: string | null
  previousPrecision: MonitoredDatePrecision | null
  /** A listing that disagrees with the date the owner chose, found or changed after they chose it. */
  suggested: MonitoredSuggestedReleaseDate | null
}

const NO_HISTORY = { changedAt: null, previousDate: null, previousPrecision: null, suggested: null }

function history(probe: MonitoredFormatRelease) {
  return {
    changedAt: probe.dateChangedAt,
    previousDate: probe.previousReleaseDate,
    previousPrecision: probe.previousPrecision,
    suggested: probe.suggested ?? null,
  }
}

interface ColumnRelease {
  date: string | null
  precision: MonitoredDatePrecision | null
}

function columnRelease(work: MonitoredWork, format: MonitoredFormat): ColumnRelease {
  if (format === 'ebook') return { date: work.ebookReleaseDate, precision: work.ebookDatePrecision }
  return { date: work.audioReleaseDate, precision: work.audioDatePrecision }
}

function datedKind(date: string, precision: MonitoredDatePrecision | null, todayIso: string): MonitoredFormatReleaseKind {
  return monitoredReleaseWindowStarted(date, precision, todayIso) ? 'released' : 'upcoming'
}

/** Null when the probe row says nothing usable yet, so the caller falls back to the date columns. */
function probeState(probe: MonitoredFormatRelease, todayIso: string): MonitoredFormatReleaseState | null {
  if (probe.status === 'unlisted') {
    return { kind: 'unlisted', date: null, precision: null, source: probe.source, checkedAt: probe.checkedAt, ...NO_HISTORY }
  }
  if (!probe.releaseDate) return null
  // Enrolment moves an inherited date out of the column and onto the pending row, so until the
  // first check lands that date is a hint like any other rather than something to lose.
  if (probe.status === 'expected' || probe.status === 'pending') {
    return {
      kind: 'expected',
      date: probe.releaseDate,
      precision: probe.precision,
      source: probe.source,
      checkedAt: probe.checkedAt,
      ...history(probe),
    }
  }
  if (probe.status === 'dated') {
    return {
      kind: datedKind(probe.releaseDate, probe.precision, todayIso),
      date: probe.releaseDate,
      precision: probe.precision,
      source: probe.source,
      checkedAt: probe.checkedAt,
      ...history(probe),
    }
  }
  return null
}

export function formatReleaseState(
  work: MonitoredWork,
  format: MonitoredFormat,
  todayIso: string = new Date().toISOString().slice(0, 10),
): MonitoredFormatReleaseState {
  const probe = work.formatReleases?.[format] ?? null
  const column = columnRelease(work, format)

  if (work.ownedFormats.includes(format)) {
    const dated = probe?.releaseDate ? probe : null
    return {
      kind: 'owned',
      date: dated?.releaseDate ?? column.date,
      precision: dated?.precision ?? column.precision,
      source: dated?.source ?? null,
      checkedAt: probe?.checkedAt ?? null,
      ...NO_HISTORY,
    }
  }

  const probed = probe ? probeState(probe, todayIso) : null
  if (probed) return probed

  if (column.date) {
    return {
      kind: datedKind(column.date, column.precision, todayIso),
      date: column.date,
      precision: column.precision,
      source: null,
      checkedAt: probe?.checkedAt ?? null,
      ...NO_HISTORY,
    }
  }

  return { kind: 'unknown', date: null, precision: null, source: null, checkedAt: probe?.checkedAt ?? null, ...NO_HISTORY }
}
