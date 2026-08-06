import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { api } from '@/lib/api'

const POLL_INTERVAL_MS = 3000
// A fresh build request kicks off asynchronously on the server: the alignment row doesn't
// exist yet on the very next status read. This bounds how many polls we'll treat a 'none'
// read as "not created yet" before giving up, instead of polling forever.
const MAX_AWAIT_BUILD_ROW_POLLS = 5

export type AlignmentStatus = 'none' | 'pending' | 'building' | 'ready' | 'failed' | 'unalignable'
export type AlignmentBuildBlockReason = 'disabled' | 'unavailable' | 'busy'

const KNOWN_STATUSES = new Set<AlignmentStatus>(['none', 'pending', 'building', 'ready', 'failed', 'unalignable'])
const BUILD_BLOCK_REASONS = new Set<AlignmentBuildBlockReason>(['disabled', 'unavailable', 'busy'])

interface AlignmentStatusResponse {
  status: string
  samplesDone?: number
  samplesTotal?: number | null
  anchorCount?: number
  builtAt?: string | null
}

interface AlignmentBuildResponse {
  status: string
}

function normalizeStatus(value: string): AlignmentStatus {
  return KNOWN_STATUSES.has(value as AlignmentStatus) ? (value as AlignmentStatus) : 'none'
}

function toBuildBlockReason(value: string): AlignmentBuildBlockReason | null {
  return BUILD_BLOCK_REASONS.has(value as AlignmentBuildBlockReason) ? (value as AlignmentBuildBlockReason) : null
}

export function useReadingAlignment() {
  const status = ref<AlignmentStatus>('none')
  const samplesDone = ref<number | null>(null)
  const samplesTotal = ref<number | null>(null)
  const anchorCount = ref<number | null>(null)
  const builtAt = ref<string | null>(null)
  const loading = ref(false)
  const mutating = ref(false)
  const error = ref<string | null>(null)
  const buildBlocked = ref<AlignmentBuildBlockReason | null>(null)

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  // True from a successful build request until the alignment row is observed (or we give up):
  // masks stale 'none' reads so polling doesn't stop before the row exists (see M4).
  let awaitingBuildRow = false
  let awaitBuildRowPolls = 0
  // Bumped on every fetchStatus call so a superseded request's late response can't overwrite fresher
  // state. Polling is serialized (see syncPolling), so this guards only explicit overlaps - a build() or
  // manual refresh landing while a poll is in flight.
  let statusRequestId = 0
  // The status snapshot a build/rebuild started from. While awaiting the build row, a read still
  // matching this snapshot is the stale pre-build row, not the new build (see isStaleBuildRead).
  let buildBaselineStatus: AlignmentStatus = 'none'
  let buildBaselineBuiltAt: string | null = null
  // Set when the owning scope disposes, so an in-flight status response can't recreate polling after
  // the control has unmounted.
  let disposed = false

  function stopPolling(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  // Serialized polling: schedule the NEXT read one interval after the previous one settled (this runs
  // from fetchStatus's finally). A fixed setInterval would keep firing on schedule regardless of how
  // long each request takes, so a request slower than the interval would be lapped every tick and the
  // request-id guard would discard every response as stale - leaving a finished build stuck on
  // 'building'. Waiting for the previous request to settle makes overlap from polling impossible;
  // genuine explicit overlaps (a build() or manual refresh during a poll) are still handled by the guard.
  function syncPolling(bookId: number): void {
    if (status.value !== 'building') {
      stopPolling()
      return
    }
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      pollTimer = null
      void fetchStatus(bookId)
    }, POLL_INTERVAL_MS)
  }

  function applyResponse(data: AlignmentStatusResponse): void {
    status.value = normalizeStatus(data.status)
    if (status.value === 'none') {
      samplesDone.value = null
      samplesTotal.value = null
      anchorCount.value = null
      builtAt.value = null
      return
    }
    samplesDone.value = data.samplesDone ?? null
    samplesTotal.value = data.samplesTotal ?? null
    anchorCount.value = data.anchorCount ?? null
    builtAt.value = data.builtAt ?? null
  }

  function applyUnknown(): void {
    status.value = 'none'
    samplesDone.value = null
    samplesTotal.value = null
    anchorCount.value = null
    builtAt.value = null
  }

  function giveUpOnBuildRow(): void {
    awaitingBuildRow = false
    awaitBuildRowPolls = 0
    applyUnknown()
  }

  // Returns true when the caller should hold the current optimistic 'building' state and wait
  // for the next poll, rather than applying the read it just got.
  function shouldKeepAwaiting(): boolean {
    if (!awaitingBuildRow) return false
    awaitBuildRowPolls += 1
    if (awaitBuildRowPolls < MAX_AWAIT_BUILD_ROW_POLLS) return true
    giveUpOnBuildRow()
    return false
  }

  // Whether a status read is the stale pre-build snapshot rather than the build just started. While
  // awaiting: 'building' means it started; 'none' means the row isn't created yet; a terminal read is
  // stale only if it exactly matches the snapshot we began from (same status AND builtAt) - a changed
  // builtAt, or a different status like 'failed', means the build genuinely advanced.
  function isStaleBuildRead(next: AlignmentStatus, nextBuiltAt: string | null): boolean {
    if (!awaitingBuildRow) return false
    if (next === 'building') return false
    if (next === 'none') return true
    return next === buildBaselineStatus && nextBuiltAt === buildBaselineBuiltAt
  }

  async function fetchStatus(bookId: number): Promise<void> {
    const requestId = ++statusRequestId
    loading.value = true
    error.value = null
    try {
      const res = await api(`/api/v1/reading-alignment/books/${bookId}/alignment`)
      // A newer fetchStatus superseded this one: drop the stale read so it cannot clobber fresher state.
      if (requestId !== statusRequestId) return
      if (!res.ok) {
        error.value = 'Failed to load alignment status'
        if (!shouldKeepAwaiting()) applyUnknown()
        return
      }
      const data = (await res.json()) as AlignmentStatusResponse
      if (requestId !== statusRequestId) return
      const normalized = normalizeStatus(data.status)
      // Hold the optimistic 'building' past a stale pre-build read (a fresh build's 'none', or a
      // rebuild's still-unchanged old terminal row) so polling doesn't stop before the build is seen.
      if (isStaleBuildRead(normalized, data.builtAt ?? null) && shouldKeepAwaiting()) return
      awaitingBuildRow = false
      awaitBuildRowPolls = 0
      applyResponse(data)
    } catch {
      if (requestId !== statusRequestId) return
      error.value = 'Failed to load alignment status'
      if (!shouldKeepAwaiting()) applyUnknown()
    } finally {
      // Only the latest request mutates shared state, and never after disposal - otherwise a late
      // 'building' response could recreate the poll interval after the control has unmounted.
      if (requestId === statusRequestId && !disposed) {
        loading.value = false
        syncPolling(bookId)
      }
    }
  }

  async function build(bookId: number, force = false): Promise<void> {
    mutating.value = true
    error.value = null
    buildBlocked.value = null
    // Snapshot the pre-build state so a stale read of the old row (e.g. rebuilding a 'ready' alignment)
    // is recognized and masked rather than applied over the optimistic 'building'.
    const baselineStatus = status.value
    const baselineBuiltAt = builtAt.value
    try {
      const url = `/api/v1/reading-alignment/books/${bookId}/build${force ? '?force=true' : ''}`
      const res = await api(url, { method: 'POST' })
      if (!res.ok) {
        // Refresh the real status first (it clears error transiently), THEN set the build error last so
        // the caller can surface it - otherwise fetchStatus wipes it and no failure toast ever shows.
        await fetchStatus(bookId)
        error.value = 'Failed to start alignment build'
        return
      }
      const data = (await res.json()) as AlignmentBuildResponse
      const blockReason = toBuildBlockReason(data.status)
      if (blockReason) {
        buildBlocked.value = blockReason
        return
      }
      // Optimistically show 'building' right away: the alignment row is created
      // asynchronously, so the status read right after this can still say 'none'.
      status.value = 'building'
      awaitingBuildRow = true
      awaitBuildRowPolls = 0
      buildBaselineStatus = baselineStatus
      buildBaselineBuiltAt = baselineBuiltAt
      await fetchStatus(bookId)
    } catch {
      await fetchStatus(bookId)
      error.value = 'Failed to start alignment build'
    } finally {
      mutating.value = false
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      stopPolling()
    })
  }

  return {
    status,
    samplesDone,
    samplesTotal,
    anchorCount,
    builtAt,
    loading,
    mutating,
    error,
    buildBlocked,
    fetchStatus,
    build,
  }
}
