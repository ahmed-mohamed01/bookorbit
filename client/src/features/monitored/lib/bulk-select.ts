import {
  MONITORED_BULK_SKIP_REASONS,
  MONITORED_WORK_BULK_LIMIT,
  monitoredBulkFormats,
  monitoredBulkSkipReason,
  monitoredFormatReleaseDate,
  monitoredFormatStatus,
  monitoredReleaseStarted,
  type MonitoredBulkRequestFormat,
  type MonitoredBulkSkipReason,
  type MonitoredFormat,
  type MonitoredWork,
} from '@bookorbit/types'

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
