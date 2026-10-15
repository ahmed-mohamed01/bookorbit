import { DEFAULT_MONITORED_STATUS_FILTERS, MONITORED_STATUS_FILTERS, parseMonitoredStatusFilters, type MonitoredStatusFilter } from '@bookorbit/types'

export function defaultStatusFilters(): MonitoredStatusFilter[] {
  return [...DEFAULT_MONITORED_STATUS_FILTERS]
}

/** A stored selection is filtered rather than trusted, and an empty one falls back to the default. */
export function readStatusFilters(stored: unknown): MonitoredStatusFilter[] {
  const parsed = parseMonitoredStatusFilters(stored)
  return parsed && parsed.length ? parsed : defaultStatusFilters()
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

/** Never leaves the selection empty: a list filtered to nothing has no way to say why. */
export function toggleStatusFilter(selection: readonly MonitoredStatusFilter[], filter: MonitoredStatusFilter): MonitoredStatusFilter[] {
  if (selection.includes(filter)) {
    return selection.length > 1 ? selection.filter((entry) => entry !== filter) : [...selection]
  }
  return parseMonitoredStatusFilters([...selection, filter]) ?? [...selection, filter]
}

/** The states the author page offers: hidden and review works have the Display menu instead. */
export const AUTHOR_STATUS_OPTIONS: readonly MonitoredStatusFilter[] = MONITORED_STATUS_FILTERS.filter((filter) => filter !== 'hidden')

export function defaultAuthorStatusFilters(): MonitoredStatusFilter[] {
  return [...AUTHOR_STATUS_OPTIONS]
}

export function readAuthorStatusFilters(stored: unknown): MonitoredStatusFilter[] {
  const parsed = (parseMonitoredStatusFilters(stored) ?? []).filter((filter) => filter !== 'hidden')
  return parsed.length ? parsed : defaultAuthorStatusFilters()
}

export function isSameStatusSelection(a: readonly MonitoredStatusFilter[], b: readonly MonitoredStatusFilter[]): boolean {
  return a.length === b.length && a.every((filter) => b.includes(filter))
}
