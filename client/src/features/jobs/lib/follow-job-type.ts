import type { JobType } from '@bookorbit/types'

import { JOBS_POLL_MS, JOBS_REFRESH_GAP_MS } from '../composables/useJobList'
import { listenToJobs } from './jobs-socket'

/** The Jobs area's own cadence: pushes are read at most this often, and polled this often while the socket is down. */
export const JOB_TYPE_REFRESH_GAP_MS = JOBS_REFRESH_GAP_MS
export const JOB_TYPE_FALLBACK_POLL_MS = JOBS_POLL_MS

/**
 * Keeps a feature's own page of one job type current from the `/jobs` push, the way the Jobs area
 * keeps its list. `refresh` runs after a job of the type changes status, or after progress while
 * `inProgress` says the page shows a running job; at most once a gap, and not while the tab is
 * hidden. While the socket is down it runs on the slow fallback poll instead. The caller loads the
 * page itself first. Returns the function that stops following.
 */
export function followJobType(type: JobType, refresh: () => unknown, inProgress: () => boolean = () => false): () => void {
  let started = false
  let stopped = false
  let stale = false
  let lastAt = Date.now()
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function hidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  function request(): void {
    if (stopped) return
    if (hidden()) {
      stale = true
      return
    }
    if (pushTimer) return
    pushTimer = setTimeout(
      () => {
        pushTimer = null
        if (stopped) return
        lastAt = Date.now()
        void refresh()
      },
      Math.max(0, JOB_TYPE_REFRESH_GAP_MS - (Date.now() - lastAt)),
    )
  }

  function setPolling(on: boolean): void {
    if (on && !pollTimer && !stopped) pollTimer = setInterval(request, JOB_TYPE_FALLBACK_POLL_MS)
    if (!on && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function handleVisibility(): void {
    if (hidden() || !stale) return
    stale = false
    request()
  }

  let live = false
  const stopListening = listenToJobs({
    changed: (event) => {
      if (event.type !== type) return
      if (event.state || inProgress()) request()
    },
    live: (next) => {
      live = next
      setPolling(!next)
      // Changes made while the socket was down were never pushed.
      if (next && started) request()
    },
  })
  started = true
  if (!live) setPolling(true)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility)

  return () => {
    if (stopped) return
    stopped = true
    stopListening()
    setPolling(false)
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility)
  }
}
