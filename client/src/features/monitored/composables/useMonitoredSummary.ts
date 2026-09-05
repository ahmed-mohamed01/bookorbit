import { ref } from 'vue'
import type { MonitoredSummary } from '@bookorbit/types'
import { fetchMonitoredSummary } from '../api/monitored'

/**
 * Module-scoped so the sidebar badge survives view remounts and every caller shares one fetch.
 * The badge is supplementary: a failed refresh leaves the previous number, or none at all.
 */
const summary = ref<MonitoredSummary | null>(null)
let fetchPromise: Promise<void> | null = null

export function resetMonitoredSummary(): void {
  summary.value = null
  fetchPromise = null
}

export function useMonitoredSummary() {
  function fetchSummary(force = false): Promise<void> {
    if (!force && summary.value) return Promise.resolve()
    if (fetchPromise) return fetchPromise
    fetchPromise = fetchMonitoredSummary()
      .then((next) => {
        summary.value = next
      })
      .catch(() => {
        // Supplementary data; the badge simply stays as it was.
      })
      .finally(() => {
        fetchPromise = null
      })
    return fetchPromise
  }

  return { summary, fetchSummary }
}
