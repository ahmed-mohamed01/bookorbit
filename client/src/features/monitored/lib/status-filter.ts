import {
  DEFAULT_MONITORED_STATUS_FILTERS,
  MONITORED_FORMATS,
  MONITORED_STATUS_FILTERS,
  MONITORED_STATUS_FILTER_BY_FORMAT_STATUS,
  monitoredFormatStatus,
  parseMonitoredStatusFilters,
  type MonitorMode,
  type MonitoredFormat,
  type MonitoredStatusFilter,
  type MonitoredWork,
} from '@bookorbit/types'
import { DEFAULT_MONITORED_DISPLAY, isDefaultDisplay, type MonitoredDisplayOptions } from './work-visibility'

export function defaultStatusFilters(): MonitoredStatusFilter[] {
  return [...DEFAULT_MONITORED_STATUS_FILTERS]
}

/** The releases tab has no Hidden status: hidden works are reached through the More section instead. */
export const RELEASE_STATUS_OPTIONS: readonly MonitoredStatusFilter[] = MONITORED_STATUS_FILTERS.filter((filter) => filter !== 'hidden')

/** A stored selection is filtered rather than trusted, and an empty one falls back to the default. */
export function readStatusFilters(stored: unknown): MonitoredStatusFilter[] {
  const parsed = (parseMonitoredStatusFilters(stored) ?? []).filter((filter) => filter !== 'hidden')
  return parsed.length ? parsed : defaultStatusFilters()
}

export function isDefaultStatusFilters(selection: readonly MonitoredStatusFilter[]): boolean {
  return (
    selection.length === DEFAULT_MONITORED_STATUS_FILTERS.length && DEFAULT_MONITORED_STATUS_FILTERS.every((filter) => selection.includes(filter))
  )
}

/** The query value the list endpoints read: the canonical order, comma separated. */
export function statusFilterQuery(selection: readonly MonitoredStatusFilter[]): string {
  return (parseMonitoredStatusFilters([...selection]) ?? []).join(',')
}

/** `hidden` belongs to the display filters, and in-progress is too transient to tick. */
function offeredOnAuthorPage(filter: MonitoredStatusFilter): boolean {
  return filter !== 'hidden' && filter !== 'in_progress'
}

export const AUTHOR_STATUS_OPTIONS: readonly MonitoredStatusFilter[] = MONITORED_STATUS_FILTERS.filter(offeredOnAuthorPage)

export function defaultAuthorStatusFilters(): MonitoredStatusFilter[] {
  return [...AUTHOR_STATUS_OPTIONS]
}

export function readAuthorStatusFilters(stored: unknown): MonitoredStatusFilter[] {
  const parsed = (parseMonitoredStatusFilters(stored) ?? []).filter(offeredOnAuthorPage)
  return parsed.length || (Array.isArray(stored) && stored.length === 0) ? parsed : defaultAuthorStatusFilters()
}

export function isSameStatusSelection(a: readonly MonitoredStatusFilter[], b: readonly MonitoredStatusFilter[]): boolean {
  return a.length === b.length && a.every((filter) => b.includes(filter))
}

/** Both filter halves back at the author default, which is what the Filters menu calls "unchanged". */
export function isDefaultAuthorFilters(display: MonitoredDisplayOptions, status?: readonly MonitoredStatusFilter[]): boolean {
  return isDefaultDisplay(display) && (!status || isSameStatusSelection(status, defaultAuthorStatusFilters()))
}

/** The release options include in-progress, which is how the releases tab tells its default apart from the author page's. */
export function isDefaultFilterSelection(
  display: MonitoredDisplayOptions,
  status: readonly MonitoredStatusFilter[] | undefined,
  options: readonly MonitoredStatusFilter[],
): boolean {
  if (!options.includes('in_progress')) return isDefaultAuthorFilters(display, status)
  return isDefaultDisplay(display) && (!status || isDefaultStatusFilters(status))
}

export function countChangedFilters(
  display: MonitoredDisplayOptions,
  status: readonly MonitoredStatusFilter[] | undefined,
  options: readonly MonitoredStatusFilter[],
): number {
  const flags = ['released', 'upcoming', 'hidden', 'placeholders', 'unconfirmed'] as const
  const displayCount = flags.filter((flag) => display[flag] !== DEFAULT_MONITORED_DISPLAY[flag]).length
  const kindsChanged =
    display.kinds.length !== DEFAULT_MONITORED_DISPLAY.kinds.length || !DEFAULT_MONITORED_DISPLAY.kinds.every((kind) => display.kinds.includes(kind))
  const defaults = options.includes('in_progress') ? defaultStatusFilters() : defaultAuthorStatusFilters()
  const statusCount = status ? MONITORED_STATUS_FILTERS.filter((filter) => status.includes(filter) !== defaults.includes(filter)).length : 0
  return displayCount + Number(kindsChanged) + statusCount
}

/**
 * The author page's status rule, mirroring the server's per-format match: a work matches when any
 * format's status maps to a selected filter, and `authorWatches` follows the author's format modes.
 */
export function workMatchesAuthorStatus(
  work: MonitoredWork,
  selection: readonly MonitoredStatusFilter[],
  formatModes: Partial<Record<MonitoredFormat, MonitorMode>>,
  today: string,
): boolean {
  return MONITORED_FORMATS.some((format) => {
    const filter =
      MONITORED_STATUS_FILTER_BY_FORMAT_STATUS[monitoredFormatStatus(work, format, today, { authorWatches: formatModes[format] !== 'off' })]
    // In-progress is too transient to filter on, so a download never vanishes mid-way.
    return filter === 'in_progress' || selection.includes(filter)
  })
}
