import { computed, watch, type Ref } from 'vue'
import type { BookRequestStatus } from '@bookorbit/types'
import { useBookRequestDetail } from '@/features/book-requests/composables/useBookRequestDetail'
import { useBookRequestProgress } from '@/features/book-requests/composables/useBookRequestProgress'
import { useCoalescedRefresh } from '@/features/book-requests/composables/useCoalescedRefresh'
import { currentRequestProgress, requestPipelineState, requestPresentationStatus } from '@/features/book-requests/requestPipeline'

/** The same window the Requests page collapses its own change-driven refetches into. */
const CHANGE_REFRESH_WINDOW_MS = 400

/** The one status that means the download is in the library, which is what changes what is owned. */
const FILED_STATUS: BookRequestStatus = 'available'

export interface MonitoredRequestProgressOptions {
  /** Called once, when a request this block watched still moving reaches the library. */
  onFiled?: (requestId: number) => void
}

/**
 * One book request watched from inside the monitored panel.
 *
 * The Requests page keeps a request current from two feeds, and this reads both rather than
 * inventing a third: percentage ticks arrive on the shared `/book-requests` socket keyed by request
 * id, and anything a percentage cannot express (a status transition, a release being taken, an
 * import landing) arrives as a coarse `changed` broadcast that is answered with a refetch. There is
 * no polling loop here because there is none upstream either.
 *
 * Lifecycle is by scope: the caller mounts this with the progress block and unmounts it when the
 * panel closes or the block collapses, which drops the socket listener and the refcount with it.
 * Once the request settles, the broadcast is still heard but no longer answered, so a queue that
 * stays open next to a finished download costs nothing.
 */
export function useMonitoredRequestProgress(requestId: Ref<number | null>, options: MonitoredRequestProgressOptions = {}) {
  const { request, loading, error, fetchRequest } = useBookRequestDetail()
  const { progressByRequest, onRequestsChanged } = useBookRequestProgress()

  /** Ticks for a request other than the one on screen, or for a superseded attempt, are not ours. */
  const live = computed(() => {
    const current = request.value
    if (!current || current.id !== requestId.value) return null
    return currentRequestProgress(current, progressByRequest.value[current.id])
  })

  const pipelineState = computed(() => (request.value ? requestPipelineState(request.value, live.value) : null))

  /** Reached its end, one way or another: filed, cancelled, rejected or failed. Nothing more will arrive. */
  const settled = computed(() => {
    const state = pipelineState.value
    return state !== null && (state.halted || state.tone === 'done')
  })

  const status = computed<BookRequestStatus | null>(() => (request.value ? requestPresentationStatus(request.value, live.value) : null))

  /**
   * Background, so a refetch answering a broadcast leaves the block showing what it already has
   * instead of flashing a skeleton over a bar that is mid-transfer.
   */
  const refreshSoon = useCoalescedRefresh(() => {
    const id = requestId.value
    if (id === null || settled.value) return
    void fetchRequest(id, { background: true })
  }, CHANGE_REFRESH_WINDOW_MS)

  onRequestsChanged(refreshSoon)

  /**
   * Filing is announced on the transition, once per request. A request already filed when this
   * mounted has nothing new behind it, so reopening a finished download must not send the page it
   * sits on back to the server; and the ticks before it lands are not the moment anything is owned.
   */
  let watchedUnfiled = false
  let announcedFiled = false

  watch(status, (next) => {
    const id = requestId.value
    if (next === null || id === null) return
    if (next !== FILED_STATUS) {
      watchedUnfiled = true
      return
    }
    if (!watchedUnfiled || announcedFiled) return
    announcedFiled = true
    options.onFiled?.(id)
  })

  watch(
    requestId,
    (id) => {
      watchedUnfiled = false
      announcedFiled = false
      if (id !== null) void fetchRequest(id)
    },
    { immediate: true },
  )

  return { request, loading, error, live, status, settled }
}
