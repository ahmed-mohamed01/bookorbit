import { getCurrentScope, onScopeDispose } from 'vue'
import type { BookProgressChangedEvent } from '@bookorbit/types'
import { useBookEvents } from './useBookEvents'

const PROGRESS_REFRESH_DEBOUNCE_MS = 250
// Devices syncing progress on every page turn emit an event every few seconds; refreshing on each one keeps views in a constant reload loop.
export const PROGRESS_REFRESH_MIN_INTERVAL_MS = 30_000

type Refresh = (event: BookProgressChangedEvent) => void | Promise<void>
const subscribers = new Map<Refresh, (() => number) | undefined>()
const events = new Map<number, BookProgressChangedEvent>()
let timer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = -Infinity
let pending = false

function run() {
  timer = null
  if (typeof document !== 'undefined' && document.hidden) {
    pending = true
    return
  }
  pending = false
  lastRefreshAt = Date.now()
  const batch = new Map(events)
  const latest = [...batch.values()].at(-1)
  events.clear()
  for (const [refresh, getBookId] of subscribers) {
    const event = getBookId ? batch.get(getBookId()) : latest
    if (event) void refresh(event)
  }
}

function onVisible() {
  if (pending && !document.hidden) run()
}

export function useBookProgressRefresh(refresh: Refresh, getBookId?: () => number): void {
  subscribers.set(refresh, getBookId)
  const cleanup = useBookEvents().onBookProgressChanged((event) => {
    events.delete(event.bookId)
    events.set(event.bookId, event)
    if (timer !== null || pending) return
    const wait = Math.max(PROGRESS_REFRESH_DEBOUNCE_MS, lastRefreshAt + PROGRESS_REFRESH_MIN_INTERVAL_MS - Date.now())
    timer = setTimeout(run, wait)
  })
  if (subscribers.size === 1 && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  if (getCurrentScope()) {
    onScopeDispose(() => {
      cleanup()
      subscribers.delete(refresh)
      if (subscribers.size) return
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = false
      events.clear()
      lastRefreshAt = -Infinity
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    })
  }
}
