export type MonitoredFilterSection = 'status' | 'release' | 'kind' | 'more'
export type MonitoredFilterSections = Record<MonitoredFilterSection, boolean>

export function readFilterSections(stored: unknown): MonitoredFilterSections {
  const defaults = { status: true, release: false, kind: false, more: false }
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  for (const key of Object.keys(defaults) as MonitoredFilterSection[]) {
    if (typeof raw[key] === 'boolean') defaults[key] = raw[key]
  }
  return defaults
}
