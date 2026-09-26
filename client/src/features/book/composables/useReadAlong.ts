import { getCurrentScope, onScopeDispose, ref } from 'vue'
import {
  READ_ALONG_BLOCK_REASONS,
  READ_ALONG_PHASES,
  READ_ALONG_STATUSES,
  type ReadAlongBlockReason,
  type ReadAlongBuildRequest,
  type ReadAlongBuildResponse,
  type ReadAlongCopySizes,
  type ReadAlongOutputBook,
  type ReadAlongPhase,
  type ReadAlongStatus,
  type ReadAlongStatusResponse,
  type StorytellerEffectiveTransport,
  type StorytellerExistingMatch,
  type StorytellerExistingMatchesResponse,
} from '@bookorbit/types'
import { api } from '@/lib/api'

// Storyteller alignment runs for minutes to hours, so this polls far slower than the in-app
// alignment sampler (3 s): the popover only has to narrate phase changes, not progress ticks.
const POLL_INTERVAL_MS = 5000
// A build request kicks the job off asynchronously, so the next status read can still show the
// pre-build row. Bounds how many such reads the optimistic 'building' survives.
const MAX_AWAIT_BUILD_ROW_POLLS = 5
// A build runs for hours, which is thousands of polls: a single 502 from a restarting proxy must not
// end the build view, so a visible build survives this many failed reads in a row.
const MAX_CONSECUTIVE_STATUS_FAILURES = 5

const STATUS_ERROR = 'Failed to load read-along status'
const BUILD_ERROR = 'Failed to start the read-along build'

const KNOWN_STATUSES = new Set<ReadAlongStatus>(READ_ALONG_STATUSES)
const KNOWN_PHASES = new Set<ReadAlongPhase>(READ_ALONG_PHASES)
const BLOCK_REASONS = new Set<ReadAlongBlockReason>(READ_ALONG_BLOCK_REASONS)
// Derived from a Record over the union rather than hand-listed, so a transport added to the contract
// fails to compile here instead of normalizing to null and rendering as an unexplained blank.
const TRANSPORTS = new Set(
  Object.keys({ 'shared-paths': null, 'api-transfer': null } satisfies Record<
    StorytellerEffectiveTransport,
    null
  >) as StorytellerEffectiveTransport[],
)

/** The slice of read-along state the presentational section needs. */
export interface ReadAlongSectionState {
  status: ReadAlongStatus
  blocked: ReadAlongBlockReason | null
  phase: ReadAlongPhase | null
  transport: StorytellerEffectiveTransport | null
  remoteTask: string | null
  remoteProgress: number | null
  targetLibraryName: string | null
  remoteCopyBytes: ReadAlongCopySizes
  keepRemoteCopy: boolean
  remoteCopyReclaimable: boolean
  // Whether the server described the read-along book at all. A ready build without one is a build
  // whose output this user cannot open, which is not the same as a build that has no output.
  hasOutputBook: boolean
  error: string | null
  mutating: boolean
}

/** 'started' is the only outcome that leaves a job running; the caller has to narrate the other three. */
export type ReadAlongBuildOutcome = 'started' | 'ready' | 'blocked' | 'failed'

function normalizeStatus(value: unknown): ReadAlongStatus {
  return KNOWN_STATUSES.has(value as ReadAlongStatus) ? (value as ReadAlongStatus) : 'none'
}

function normalizePhase(value: unknown): ReadAlongPhase | null {
  return KNOWN_PHASES.has(value as ReadAlongPhase) ? (value as ReadAlongPhase) : null
}

function normalizeBlocked(value: unknown): ReadAlongBlockReason | null {
  return BLOCK_REASONS.has(value as ReadAlongBlockReason) ? (value as ReadAlongBlockReason) : null
}

function normalizeTransport(value: unknown): StorytellerEffectiveTransport | null {
  return TRANSPORTS.has(value as StorytellerEffectiveTransport) ? (value as StorytellerEffectiveTransport) : null
}

function normalizeProgress(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return Math.min(1, Math.max(0, value))
}

/**
 * Read-along generation state for one book, mirroring useReadingAlignment. State is per-consumer
 * rather than module-scoped because at most one control shows the read-along row for a given book
 * (the Link popover for a linked pair, the alignment popover for a self-pair), so there is no second
 * poller to de-duplicate.
 */
export function useReadAlong() {
  const status = ref<ReadAlongStatus>('none')
  const blocked = ref<ReadAlongBlockReason | null>(null)
  const phase = ref<ReadAlongPhase | null>(null)
  const transport = ref<StorytellerEffectiveTransport | null>(null)
  const remoteTask = ref<string | null>(null)
  const remoteProgress = ref<number | null>(null)
  const outputBook = ref<ReadAlongOutputBook | null>(null)
  const targetLibraryId = ref<number | null>(null)
  const targetLibraryName = ref<string | null>(null)
  const remoteCopyBytes = ref<ReadAlongCopySizes>({ epub: null, audio: null, readAlong: null })
  // Adopted from the instance default on every status read, and overridden per build once the user
  // touches the toggle. Never defaulted to "keep" here: a wrong guess offers to hold hundreds of MB.
  const keepRemoteCopy = ref(false)
  // The last instance default the server reported, so dropping a choice restores what the server
  // would apply instead of leaving the discarded choice on the toggle.
  const keepRemoteCopyDefault = ref(false)
  const remoteCopyReclaimable = ref(true)
  const keepRemoteCopyTouched = ref(false)
  let lastBookId: number | null = null
  const error = ref<string | null>(null)
  const builtAt = ref<string | null>(null)
  const mutating = ref(false)
  const existingMatches = ref<StorytellerExistingMatch[]>([])

  const readyHandlers: ((book: ReadAlongOutputBook | null) => void)[] = []

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let statusRequestId = 0
  let existingRequestId = 0
  let awaitingBuildRow = false
  let awaitBuildRowPolls = 0
  let consecutiveStatusFailures = 0
  let buildBaselineStatus: ReadAlongStatus = 'none'
  let buildBaselineBuiltAt: string | null = null
  let disposed = false

  function stopPolling(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  // Serialized polling: the next read is scheduled one interval after the previous one settled (from
  // fetchStatus's finally), so a slow request can never be lapped and discarded by the request-id
  // guard, which would otherwise strand the row on 'building' forever.
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

  function startPolling(bookId: number): void {
    if (disposed) return
    syncPolling(bookId)
  }

  function onReady(handler: (book: ReadAlongOutputBook | null) => void): void {
    readyHandlers.push(handler)
  }

  function notifyReady(): void {
    const book = outputBook.value
    for (const handler of readyHandlers) handler(book)
  }

  function applyResponse(data: ReadAlongStatusResponse): void {
    const previous = status.value
    status.value = normalizeStatus(data.status)
    blocked.value = normalizeBlocked(data.blocked)
    phase.value = normalizePhase(data.phase)
    transport.value = normalizeTransport(data.transport)
    remoteTask.value = data.remoteTask ?? null
    remoteProgress.value = normalizeProgress(data.remoteProgress)
    outputBook.value = data.outputBook ?? null
    targetLibraryId.value = data.targetLibraryId ?? null
    targetLibraryName.value = data.targetLibraryName ?? null
    remoteCopyBytes.value = data.remoteCopyBytes ?? { epub: null, audio: null, readAlong: null }
    keepRemoteCopyDefault.value = data.keepRemoteCopyByDefault === true
    if (!keepRemoteCopyTouched.value) keepRemoteCopy.value = keepRemoteCopyDefault.value
    remoteCopyReclaimable.value = data.remoteCopyReclaimable !== false
    builtAt.value = data.builtAt ?? null
    error.value = data.status === 'failed' ? (data.error ?? null) : null
    // Only a build that finished in this session notifies: a page opened on an already-ready
    // read-along has nothing new to refresh.
    if (status.value === 'ready' && previous === 'building') notifyReady()
  }

  function applyUnknown(): void {
    status.value = 'none'
    blocked.value = null
    phase.value = null
    transport.value = null
    remoteTask.value = null
    remoteProgress.value = null
    outputBook.value = null
    builtAt.value = null
  }

  // The failure budget belongs to one continuous view of one build, so dropping that view hands a
  // full budget to whatever is shown next. Carrying a spent budget forward would cost the next build
  // its row on the first failed poll.
  function giveUpOnBuildRow(): void {
    awaitingBuildRow = false
    awaitBuildRowPolls = 0
    consecutiveStatusFailures = 0
    applyUnknown()
  }

  // A failed read says nothing about the row on screen, so any row that exists keeps showing (and,
  // through syncPolling, a build keeps its timer) until several reads in a row have failed. Anything
  // else would replace a finished or running read-along with "no read-along yet" the first time a
  // proxy hiccups. A row that is genuinely gone still clears when a read succeeds reporting 'none'.
  function handleStatusFailure(): void {
    consecutiveStatusFailures += 1
    if (status.value !== 'none' && consecutiveStatusFailures < MAX_CONSECUTIVE_STATUS_FAILURES) return
    giveUpOnBuildRow()
    error.value = STATUS_ERROR
  }

  // True while the optimistic 'building' should be held for one more poll instead of applying the
  // read that just landed.
  function shouldKeepAwaiting(): boolean {
    if (!awaitingBuildRow) return false
    awaitBuildRowPolls += 1
    if (awaitBuildRowPolls < MAX_AWAIT_BUILD_ROW_POLLS) return true
    giveUpOnBuildRow()
    return false
  }

  // A read is stale while awaiting the build row when it still shows the pre-build snapshot: 'none'
  // (the row does not exist yet) or the exact terminal state the rebuild started from.
  function isStaleBuildRead(next: ReadAlongStatus, nextBuiltAt: string | null): boolean {
    if (!awaitingBuildRow) return false
    if (next === 'building') return false
    if (next === 'none') return true
    return next === buildBaselineStatus && nextBuiltAt === buildBaselineBuiltAt
  }

  async function fetchStatus(bookId: number): Promise<void> {
    // The per-book keep-copy choice does not follow the user to the next book. The popover and the
    // alignment control both keep one composable instance per mounted control, and a book detail
    // view can be reused for a different book, so the instance has to forget the choice with it.
    if (lastBookId !== bookId) {
      lastBookId = bookId
      keepRemoteCopyTouched.value = false
    }
    const requestId = ++statusRequestId
    try {
      const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/status`)
      if (requestId !== statusRequestId) return
      if (!res.ok) {
        handleStatusFailure()
        return
      }
      const data = (await res.json()) as ReadAlongStatusResponse
      if (requestId !== statusRequestId) return
      consecutiveStatusFailures = 0
      if (isStaleBuildRead(normalizeStatus(data.status), data.builtAt ?? null) && shouldKeepAwaiting()) return
      awaitingBuildRow = false
      awaitBuildRowPolls = 0
      applyResponse(data)
    } catch {
      if (requestId !== statusRequestId) return
      handleStatusFailure()
    } finally {
      // Only the latest request drives polling, and never after disposal: a late 'building' response
      // must not resurrect the timer once the control has unmounted.
      if (requestId === statusRequestId && !disposed) syncPolling(bookId)
    }
  }

  /** Drops a per-book choice so the instance default applies again, for a visit that starts over. */
  function resetKeepRemoteCopy(): void {
    keepRemoteCopyTouched.value = false
    keepRemoteCopy.value = keepRemoteCopyDefault.value
  }

  /**
   * Forgets everything read for the current pair, for a pair that no longer exists. In-flight reads
   * are invalidated too, so a late answer about the old pair cannot land on the next one.
   */
  function reset(): void {
    stopPolling()
    statusRequestId += 1
    existingRequestId += 1
    awaitingBuildRow = false
    awaitBuildRowPolls = 0
    consecutiveStatusFailures = 0
    applyUnknown()
    error.value = null
    targetLibraryId.value = null
    targetLibraryName.value = null
    existingMatches.value = []
  }

  function setKeepRemoteCopy(value: boolean): void {
    keepRemoteCopyTouched.value = true
    keepRemoteCopy.value = value
  }

  async function build(bookId: number, request: ReadAlongBuildRequest = {}): Promise<ReadAlongBuildOutcome> {
    // Sent only once the user has actually chosen, so an untouched build follows the instance setting.
    const payload: ReadAlongBuildRequest = keepRemoteCopyTouched.value ? { ...request, cleanUpRemote: !keepRemoteCopy.value } : request
    mutating.value = true
    error.value = null
    blocked.value = null
    const baselineStatus = status.value
    const baselineBuiltAt = builtAt.value
    try {
      const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        // Refresh first (it clears the error), then set the build error last so the caller can still
        // surface it.
        await fetchStatus(bookId)
        error.value = BUILD_ERROR
        return 'failed'
      }
      const data = (await res.json()) as ReadAlongBuildResponse
      const blockReason = normalizeBlocked(data.blocked)
      const acceptedStatus = normalizeStatus(data.status)
      if (blockReason) {
        blocked.value = blockReason
        status.value = acceptedStatus
        // A refusal can still hand back a build someone else started ('busy' over a claimed pair,
        // 'unreachable' over a running one). That row spins, and nothing else here starts a timer, so
        // without this it would spin until the popover is closed and reopened.
        startPolling(bookId)
        return 'blocked'
      }
      // Not every accepted request starts a job: an unforced build of a pair that already has a
      // ready read-along answers 'ready' without building. Waiting for a build row that will never
      // appear would spin for five polls and then drop back to the Generate button.
      if (acceptedStatus !== 'building') {
        status.value = acceptedStatus
        await fetchStatus(bookId)
        if (status.value === 'ready') notifyReady()
        return status.value === 'ready' ? 'ready' : 'blocked'
      }
      status.value = 'building'
      awaitingBuildRow = true
      awaitBuildRowPolls = 0
      buildBaselineStatus = baselineStatus
      buildBaselineBuiltAt = baselineBuiltAt
      await fetchStatus(bookId)
      return 'started'
    } catch {
      await fetchStatus(bookId)
      error.value = BUILD_ERROR
      return 'failed'
    } finally {
      mutating.value = false
    }
  }

  /**
   * Asks the server to stop a running build. False covers every way it did not happen, including a
   * server that has no cancel route yet, so the caller can say so instead of pretending it stopped.
   */
  async function cancel(bookId: number): Promise<boolean> {
    mutating.value = true
    try {
      const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/build`, { method: 'DELETE' })
      if (!res.ok) return false
      // A build started in this session may still be awaiting its row. A cancelled build never gets
      // one, so waiting for it would hold Building for several more polls.
      awaitingBuildRow = false
      awaitBuildRowPolls = 0
      await fetchStatus(bookId)
      return true
    } catch {
      return false
    } finally {
      mutating.value = false
    }
  }

  // Match lookups only enrich the "import instead of generating" offer, so a failure empties the list
  // and stays out of `error`, which narrates the build itself.
  async function fetchExisting(bookId: number): Promise<void> {
    const requestId = ++existingRequestId
    try {
      const res = await api(`/api/v1/storyteller/read-along/books/${bookId}/existing`)
      if (requestId !== existingRequestId) return
      if (!res.ok) {
        existingMatches.value = []
        return
      }
      const data = (await res.json()) as StorytellerExistingMatchesResponse
      if (requestId !== existingRequestId) return
      existingMatches.value = Array.isArray(data.matches) ? data.matches : []
    } catch {
      if (requestId === existingRequestId) existingMatches.value = []
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
    blocked,
    phase,
    transport,
    remoteTask,
    remoteProgress,
    outputBook,
    targetLibraryId,
    targetLibraryName,
    remoteCopyBytes,
    keepRemoteCopy,
    remoteCopyReclaimable,
    setKeepRemoteCopy,
    resetKeepRemoteCopy,
    error,
    mutating,
    existingMatches,
    fetchStatus,
    build,
    cancel,
    fetchExisting,
    onReady,
    reset,
  }
}
