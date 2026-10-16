import type { Component } from 'vue'
import { BookCheck, CircleAlert, CircleDashed, CircleHelp, Clock3, Download, EyeOff, FolderInput, Hourglass, TriangleAlert } from '@lucide/vue'
import {
  MONITORED_ACTIVE_REQUEST_STATUSES,
  monitoredFormatReleaseDate,
  monitoredFormatStatus,
  monitoredReleaseStarted,
  type MonitoredFormat,
  type MonitoredFormatStatus,
  type MonitoredWork,
} from '@bookorbit/types'

export type { MonitoredFormatStatus }

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export const ACTIVE_REQUEST_STATUSES = MONITORED_ACTIVE_REQUEST_STATUSES

export interface WorkFormatStatusOptions {
  /** False when the author does not monitor this format at all. */
  authorWatches?: boolean
  /** A request this page just sent, before the server has answered with its state. */
  optimisticQueued?: boolean
  today?: string
}

/** The shared status, plus the one thing only the page knows: a request it sent a moment ago. */
export function workFormatStatus(work: MonitoredWork, format: MonitoredFormat, options: WorkFormatStatusOptions = {}): MonitoredFormatStatus {
  const status = monitoredFormatStatus(work, format, options.today ?? todayUtc(), { authorWatches: options.authorWatches })
  if (options.optimisticQueued && status !== 'owned' && !ACTIVE_REQUEST_STATUSES.has(status)) return 'queued'
  return status
}

export interface FormatStatusTone {
  icon: Component
  /** Chip surface: border, fill and text, from theme tokens only. */
  chip: string
}

/** One look per status, shared by the drawer, the grid card and the list row. */
export const FORMAT_STATUS_TONES: Record<MonitoredFormatStatus, FormatStatusTone> = {
  owned: { icon: BookCheck, chip: 'border-[var(--pill-success)]/40 bg-[var(--pill-success)]/10 text-[var(--pill-success)]' },
  downloading: { icon: Download, chip: 'border-primary/40 bg-primary/10 text-primary' },
  importing: { icon: FolderInput, chip: 'border-primary/40 bg-primary/10 text-primary' },
  queued: { icon: Hourglass, chip: 'border-[var(--pill-pending)]/40 bg-[var(--pill-pending)]/10 text-[var(--pill-pending)]' },
  needs_choice: { icon: TriangleAlert, chip: 'border-[var(--pill-warning)]/40 bg-[var(--pill-warning)]/10 text-[var(--pill-warning)]' },
  failed: { icon: CircleAlert, chip: 'border-destructive/40 bg-destructive/10 text-destructive' },
  not_watching: { icon: EyeOff, chip: 'border-border bg-muted text-muted-foreground opacity-60' },
  missing: { icon: CircleDashed, chip: 'border-dashed border-foreground/40 bg-transparent text-foreground' },
  upcoming: { icon: Clock3, chip: 'border-[var(--pill-info)]/40 bg-[var(--pill-info)]/10 text-[var(--pill-info)]' },
  unannounced: { icon: CircleHelp, chip: 'border-border bg-muted text-muted-foreground' },
}

export type EditionRowAction = 'open' | 'view-request' | 'resolve' | 'retry' | 'request' | 'request-once' | null

/**
 * The one action a format's row offers. Only actions an existing route or endpoint backs are named;
 * `canRequest` is whether this viewer may send requests for this format at all.
 */
export function editionRowAction(
  work: MonitoredWork,
  format: MonitoredFormat,
  status: MonitoredFormatStatus,
  canRequest: boolean,
  today: string = todayUtc(),
): EditionRowAction {
  const hasRequest = work.requestIds?.[format] != null
  switch (status) {
    case 'owned':
      return 'open'
    case 'downloading':
    case 'importing':
    case 'queued':
      return hasRequest ? 'view-request' : null
    case 'needs_choice':
      return hasRequest ? 'resolve' : null
    case 'failed':
      if (canRequest) return 'retry'
      return hasRequest ? 'view-request' : null
    case 'missing':
      return canRequest ? 'request' : null
    case 'not_watching': {
      const { date, precision } = monitoredFormatReleaseDate(work, format)
      return canRequest && monitoredReleaseStarted(date, precision, today) ? 'request-once' : null
    }
    case 'upcoming':
    case 'unannounced':
      return canRequest ? 'request' : null
    default:
      return null
  }
}

/** Whole calendar days from today to a date, negative once it has passed. */
export function daysUntil(date: Date, now: Date = new Date()): number {
  const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((target - start) / 86_400_000)
}
