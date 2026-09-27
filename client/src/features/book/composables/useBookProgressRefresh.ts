import { getCurrentScope, onScopeDispose } from 'vue'
import { useBookEvents } from './useBookEvents'

const PROGRESS_REFRESH_DEBOUNCE_MS = 250
// Devices syncing progress on every page turn emit an event every few seconds; refreshing on each
// one keeps views in a constant reload loop.
export const PROGRESS_REFRESH_MIN_INTERVAL_MS = 30_000

export function useBookProgressRefresh(refresh: () => void | Promise<void>): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRefreshAt = -Infinity

  function run() {
    timer = null
    lastRefreshAt = Date.now()
    void refresh()
  }

  const cleanup = useBookEvents().onBookProgressChanged(() => {
    if (timer) return
    const wait = Math.max(PROGRESS_REFRESH_DEBOUNCE_MS, lastRefreshAt + PROGRESS_REFRESH_MIN_INTERVAL_MS - Date.now())
    timer = setTimeout(run, wait)
  })

  if (getCurrentScope()) {
    onScopeDispose(() => {
      cleanup()
      if (timer) clearTimeout(timer)
    })
  }
}
