import { MonitoredApiError } from './api-error'
import type { MonitoredPage } from '@bookorbit/types'

export interface MonitoredRefreshSummary {
  refreshed: number
  skipped: number
  failed: number
}

/** A per-author cooldown answers 429: the server declining to re-check yet, not a failure. */
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * Refreshes authors one at a time so a large library never fans out onto the metadata providers.
 * Every author is attempted even when an earlier one fails, so one bad author cannot strand the rest.
 */
export type MonitoredRefreshProgress = (processed: number, total: number) => void

export async function refreshAuthorsSequentially(
  ids: readonly string[],
  refresh: (id: string) => Promise<unknown>,
  onProgress?: MonitoredRefreshProgress,
  offset = 0,
  total = ids.length,
): Promise<MonitoredRefreshSummary> {
  const summary: MonitoredRefreshSummary = { refreshed: 0, skipped: 0, failed: 0 }
  for (const [index, id] of ids.entries()) {
    try {
      await refresh(id)
      summary.refreshed += 1
    } catch (cause) {
      if (cause instanceof MonitoredApiError && cause.status === HTTP_TOO_MANY_REQUESTS) summary.skipped += 1
      else summary.failed += 1
    }
    onProgress?.(offset + index + 1, total)
  }
  return summary
}

/**
 * Walks the lightweight owned-id endpoint one bounded page at a time, then refreshes that page
 * sequentially. No full author list or full id collection is retained in the browser.
 */
export async function refreshAllAuthorsSequentially(
  fetchPage: (page: number) => Promise<MonitoredPage<string>>,
  refresh: (id: string) => Promise<unknown>,
  onProgress?: MonitoredRefreshProgress,
): Promise<MonitoredRefreshSummary> {
  const summary: MonitoredRefreshSummary = { refreshed: 0, skipped: 0, failed: 0 }
  let page = 0
  let processed = 0

  while (true) {
    const result = await fetchPage(page)
    if (result.items.length === 0) return summary
    const current = await refreshAuthorsSequentially(result.items, refresh, onProgress, processed, result.total)
    summary.refreshed += current.refreshed
    summary.skipped += current.skipped
    summary.failed += current.failed
    processed += result.items.length
    if (processed >= result.total || result.items.length < result.size) return summary
    page += 1
  }
}
