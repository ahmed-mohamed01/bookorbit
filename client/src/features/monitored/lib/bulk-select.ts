import {
  MONITORED_BULK_SKIP_REASONS,
  MONITORED_FORMATS,
  MONITORED_WORK_BULK_LIMIT,
  monitoredBulkFormats,
  monitoredBulkSkipReason,
  monitoredFormatReleaseDate,
  monitoredFormatStatus,
  monitoredReleaseStarted,
  type MonitoredBulkRequestFormat,
  type MonitoredBulkSkipReason,
  type MonitoredFormat,
  type MonitoredReleaseItem,
  type MonitoredWork,
} from '@bookorbit/types'
import { workFormatStatus } from './format-status'

export interface BulkRequestPreview {
  ebooks: number
  audiobooks: number
  skipped: Record<MonitoredBulkSkipReason, number>
}

export function emptySkipCounts(): Record<MonitoredBulkSkipReason, number> {
  return Object.fromEntries(MONITORED_BULK_SKIP_REASONS.map((reason) => [reason, 0])) as Record<MonitoredBulkSkipReason, number>
}

export function bulkRequestPreview(works: readonly MonitoredWork[], format: MonitoredBulkRequestFormat, today: string): BulkRequestPreview {
  const preview: BulkRequestPreview = { ebooks: 0, audiobooks: 0, skipped: emptySkipCounts() }
  for (const work of works) {
    for (const each of monitoredBulkFormats(format)) {
      const reason = monitoredBulkSkipReason(work, each, today)
      if (reason) preview.skipped[reason] += 1
      else if (each === 'ebook') preview.ebooks += 1
      else preview.audiobooks += 1
    }
  }
  return preview
}

export function isMissing(work: MonitoredWork, format: MonitoredFormat, today: string): boolean {
  return monitoredFormatStatus(work, format, today) === 'missing'
}

export function isReleased(work: MonitoredWork, format: MonitoredFormat, today: string): boolean {
  const { date, precision } = monitoredFormatReleaseDate(work, format)
  return monitoredReleaseStarted(date, precision, today)
}

export function chunk<T>(items: readonly T[], size: number = MONITORED_WORK_BULK_LIMIT): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/** A release row still has a watched format that is not in the library, so a bulk action has something to do. */
export function releaseItemHasFormatToGet(item: MonitoredReleaseItem): boolean {
  return MONITORED_FORMATS.some((format) => {
    const mode = item.authorModes?.[format]
    const status = workFormatStatus(item.work, format, { authorWatches: mode !== 'off' })
    return status !== 'owned' && status !== 'not_watching'
  })
}

/**
 * The works a shift-click sweeps in a list of rows, from the anchor row to the clicked one in render
 * order, keeping only rows that may be picked. Null when either row is not on screen.
 */
export function sweptRowWorkIds<T extends { workId: string }>(
  rows: readonly T[],
  anchorKey: string,
  key: string,
  keyOf: (row: T) => string,
  selectable: (row: T) => boolean,
): string[] | null {
  const from = rows.findIndex((row) => keyOf(row) === anchorKey)
  const to = rows.findIndex((row) => keyOf(row) === key)
  if (from < 0 || to < 0) return null
  const swept = rows.slice(Math.min(from, to), Math.max(from, to) + 1).filter(selectable)
  return [...new Set(swept.map((row) => row.workId))]
}
