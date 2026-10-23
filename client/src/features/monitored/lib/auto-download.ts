import { isWorkVisible, monitoredFormatReleaseDate, type MonitorMode, type MonitoredFormat, type MonitoredWork } from '@bookorbit/types'
import type { CardBadgeKind } from './card-badge'

/**
 * The mode a format effectively runs in. A book's override picks between auto and notify, but never
 * wakes a format its author has turned off. An override on counts as auto-all because the server
 * requests that book once its release is due, whatever window the author's own mode applies.
 */
export function effectiveFormatMode(work: MonitoredWork, format: MonitoredFormat, mode: MonitorMode | null | undefined): MonitorMode | null {
  if (mode == null) return null
  if (mode === 'off') return mode
  const override = work.autoDownload?.[format]
  if (override === undefined) return mode
  return override ? 'auto-all' : 'notify'
}

/** A day date is due from that day; a month or year date only once its whole range has passed, as on the server. */
function releaseDue(value: string, today: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 10) return trimmed <= today
  if (trimmed.length === 7) {
    const lastDay = new Date(Date.UTC(Number(trimmed.slice(0, 4)), Number(trimmed.slice(5, 7)), 0)).getUTCDate()
    return `${trimmed}-${String(lastDay).padStart(2, '0')}` < today
  }
  return `${trimmed.slice(0, 4)}-12-31` < today
}

export interface AutoDownloadOptions {
  authorPaused?: boolean
  today?: string
}

/** Whether a card badge of this kind is a format the next refresh or release will request on its own. */
export function willAutoDownload(
  work: MonitoredWork,
  format: MonitoredFormat,
  kind: CardBadgeKind | null,
  mode: MonitorMode | null | undefined,
  options: AutoDownloadOptions = {},
): boolean {
  if (options.authorPaused) return false
  if (!isWorkVisible(work) || work.monitorState !== 'monitoring' || work.possibleMatches?.[format] != null) return false
  const effective = effectiveFormatMode(work, format, mode)
  if (kind === 'upcoming') return effective === 'auto-all' || effective === 'auto-upcoming'
  if (kind !== 'missing' || effective !== 'auto-all') return false
  const { date } = monitoredFormatReleaseDate(work, format)
  return date != null && releaseDue(date, options.today ?? new Date().toISOString().slice(0, 10))
}
