import { computed, ref, watch, type Ref } from 'vue'
import { monitoredFormatReleaseDate, type MonitorMode, type MonitoredBookWork, type MonitoredFormat } from '@bookorbit/types'
import { fetchMonitoredBookWork } from '../api/monitored'
import { workFormatStatus } from '../lib/format-status'

// Concurrent readers of one book share a single request; nothing outlives it, so a revisit reads fresh.
const inFlight = new Map<number, Promise<MonitoredBookWork | null>>()

function fetchOnce(bookId: number): Promise<MonitoredBookWork | null> {
  const pending = inFlight.get(bookId)
  if (pending) return pending
  const request = fetchMonitoredBookWork(bookId)
    .catch(() => null)
    .finally(() => inFlight.delete(bookId))
  inFlight.set(bookId, request)
  return request
}

/**
 * What the watchlist knows about a library book's missing format, for the book page. Nothing is
 * fetched until `enabled`, and a book that is not on the watchlist (404) simply has no entry.
 */
export function useBookMonitoredWork(bookId: Ref<number | null>, format: Ref<MonitoredFormat | null>, enabled: Ref<boolean>) {
  const entry = ref<MonitoredBookWork | null>(null)
  let generation = 0

  async function load(): Promise<void> {
    const id = bookId.value
    const asked = ++generation
    entry.value = null
    if (id === null || !enabled.value) return
    const found = await fetchOnce(id)
    if (asked === generation) entry.value = found
  }

  async function refresh(): Promise<void> {
    const id = bookId.value
    if (id === null || !enabled.value) return
    const asked = ++generation
    inFlight.delete(id)
    const found = await fetchOnce(id)
    if (asked === generation) entry.value = found
  }

  watch([bookId, enabled], () => void load(), { immediate: true })

  const mode = computed<MonitorMode | null>(() => (entry.value && format.value ? entry.value.authorModes[format.value] : null))

  const status = computed(() => {
    if (!entry.value || !format.value) return null
    return workFormatStatus(entry.value.work, format.value, { authorWatches: mode.value !== 'off' })
  })

  const release = computed(() => (entry.value && format.value ? monitoredFormatReleaseDate(entry.value.work, format.value) : null))

  const hasRequest = computed(() => {
    if (!entry.value || !format.value) return false
    const { requestIds, requestStatuses } = entry.value.work
    return requestIds?.[format.value] != null || requestStatuses?.[format.value] != null
  })

  return { entry, status, mode, release, hasRequest, refresh }
}
