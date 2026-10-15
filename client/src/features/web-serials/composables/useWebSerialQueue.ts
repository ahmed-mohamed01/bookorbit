import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { WebSerialJob, WebSerialJobItem, WebSerialJobList, WebSerialJobScope } from '@bookorbit/types'
import {
  cancelSerialJob,
  clearFinishedSerialJobs,
  fetchSerialJobDetail,
  fetchSerialJobs,
  moveSerialJobToTop,
  pauseSerialJob,
  pauseSerialQueue,
  removeSerialJob,
  resumeSerialJob,
  resumeSerialQueue,
  retrySerialJob,
  retrySerialJobItem,
} from '../api/webSerials'
import type { SerialJobAction } from '../lib/serialJobStatus'
import { messageOf } from '../lib/messageOf'

export const ACTIVE_POLL_MS = 3000
export const IDLE_POLL_MS = 30000
export const QUEUE_PAGE_SIZE = 50

export interface SerialJobDetailState {
  items: WebSerialJobItem[]
  loading: boolean
  error: string | null
  retryingItemIds: ReadonlySet<number>
}

export function nextPollDelay(activeCount: number, pageVisible: boolean): number {
  return activeCount > 0 && pageVisible ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

/** `detailsShown`: whether the job list is on screen. Expanded jobs' item lists are only refetched while it is. */
export function useWebSerialQueue(detailsShown: Ref<boolean> = ref(true)) {
  const jobs = ref<WebSerialJob[]>([])
  const activeCount = ref(0)
  const queuePaused = ref(false)
  const scope = ref<WebSerialJobScope>('mine')
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  const busyIds = ref<Set<number>>(new Set())
  const queueBusy = ref(false)
  const clearing = ref(false)
  const expandedIds = ref<Set<number>>(new Set())
  const details = ref<Record<number, SerialJobDetailState>>({})
  const pages = ref(1)
  const hasMore = ref(false)
  const loadingMore = ref(false)

  const detailStamps = new Map<number, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let current: Promise<void> | null = null
  let rerun = false
  let rerunFull = false

  const isEmpty = computed(() => loaded.value && jobs.value.length === 0)
  const finishedCount = ref(0)

  function pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  async function fetchPages(requested: WebSerialJobScope, full: boolean): Promise<{ items: WebSerialJob[]; head: WebSerialJobList }> {
    const items: WebSerialJob[] = []
    let head: WebSerialJobList | null = null
    const pageCount = full ? pages.value : 1
    for (let page = 0; page < pageCount; page++) {
      const list = await fetchSerialJobs(requested, QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE)
      head ??= list
      const seen = new Set(items.map((job) => job.id))
      items.push(...list.items.filter((job) => !seen.has(job.id)))
      if (list.items.length < QUEUE_PAGE_SIZE || items.length >= list.total) break
    }
    return { items, head: head as WebSerialJobList }
  }

  /** A poll tick fetches only the first page; jobs from pages the user loaded further down keep their last state until a full refresh. */
  function mergeHead(items: WebSerialJob[]): WebSerialJob[] {
    const headIds = new Set(items.map((job) => job.id))
    return [...items, ...jobs.value.filter((job) => !headIds.has(job.id))]
  }

  async function fetchOnce(full: boolean): Promise<void> {
    const requested = scope.value
    if (!loaded.value) loading.value = true
    try {
      const { items: fetched, head } = await fetchPages(requested, full)
      if (requested !== scope.value) return
      const items = full || pages.value === 1 ? fetched : mergeHead(fetched)
      jobs.value = items
      hasMore.value = items.length < head.total
      finishedCount.value = head.finishedCount
      activeCount.value = head.activeCount
      queuePaused.value = head.queuePaused
      error.value = null
      loaded.value = true
      pruneExpanded()
      await refreshExpandedDetails()
    } catch (cause) {
      if (requested === scope.value) error.value = messageOf(cause, 'webSerials.api.queue')
    } finally {
      loading.value = false
    }
  }

  /** A call made while a poll is in flight is not dropped: it runs once more after that poll, so it never reads a pre-action response. */
  function refresh(full = true): Promise<void> {
    if (current) {
      rerun = true
      rerunFull ||= full
      return current
    }
    rerunFull = full
    current = (async () => {
      try {
        do {
          rerun = false
          const useFull = rerunFull
          rerunFull = false
          await fetchOnce(useFull)
        } while (rerun)
      } finally {
        current = null
      }
    })()
    return current
  }

  async function loadMore(): Promise<void> {
    if (loadingMore.value || !hasMore.value) return
    loadingMore.value = true
    pages.value += 1
    try {
      await refreshNow()
    } finally {
      loadingMore.value = false
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    clearTimer()
    if (!running) return
    timer = setTimeout(
      () => {
        void tick()
      },
      nextPollDelay(activeCount.value, pageVisible()),
    )
  }

  async function tick(): Promise<void> {
    await refresh(false)
    schedule()
  }

  function handleVisibilityChange(): void {
    if (!running || !pageVisible()) return
    void tick()
  }

  function start(): void {
    if (running) return
    running = true
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void tick()
  }

  function stop(): void {
    running = false
    clearTimer()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }

  /** Called after a job is created or acted on, so the new state and the faster cadence show up without waiting out the idle delay. */
  async function refreshNow(): Promise<void> {
    await refresh()
    schedule()
  }

  async function setScope(next: WebSerialJobScope): Promise<void> {
    if (scope.value === next) return
    scope.value = next
    expandedIds.value = new Set()
    details.value = {}
    jobs.value = []
    pages.value = 1
    hasMore.value = false
    finishedCount.value = 0
    detailStamps.clear()
    loaded.value = false
    await refreshNow()
  }

  function replaceJob(updated: WebSerialJob): void {
    jobs.value = jobs.value.map((job) => (job.id === updated.id ? { ...job, ...updated, owner: updated.owner ?? job.owner } : job))
  }

  function patchDetail(id: number, patch: Partial<SerialJobDetailState>): void {
    const current = details.value[id] ?? { items: [], loading: false, error: null, retryingItemIds: new Set<number>() }
    details.value = { ...details.value, [id]: { ...current, ...patch } }
  }

  function stampOf(job: WebSerialJob): string {
    return [job.status, job.unitsDone, job.unitsFailed, job.unitsSkipped, job.message].join('|')
  }

  async function loadDetail(id: number): Promise<void> {
    if (!details.value[id]) patchDetail(id, { loading: true })
    const job = jobs.value.find((candidate) => candidate.id === id)
    if (job) detailStamps.set(id, stampOf(job))
    try {
      const detail = await fetchSerialJobDetail(id)
      patchDetail(id, { items: detail.items, loading: false, error: null })
    } catch (cause) {
      patchDetail(id, { loading: false, error: messageOf(cause, 'webSerials.api.jobDetail') })
    }
  }

  function pruneExpanded(): void {
    const present = new Set(jobs.value.map((job) => job.id))
    if ([...expandedIds.value].every((id) => present.has(id))) return
    expandedIds.value = new Set([...expandedIds.value].filter((id) => present.has(id)))
  }

  async function refreshExpandedDetails(): Promise<void> {
    if (!detailsShown.value || !pageVisible()) return
    const ids = jobs.value.filter((job) => expandedIds.value.has(job.id) && detailStamps.get(job.id) !== stampOf(job)).map((job) => job.id)
    await Promise.all(ids.map(loadDetail))
  }

  async function toggleExpanded(id: number): Promise<void> {
    const next = new Set(expandedIds.value)
    if (next.has(id)) {
      next.delete(id)
      expandedIds.value = next
      return
    }
    next.add(id)
    expandedIds.value = next
    await loadDetail(id)
  }

  async function runJobAction(id: number, action: (id: number) => Promise<WebSerialJob | void>, fallback: string): Promise<boolean> {
    if (busyIds.value.has(id)) return false
    busyIds.value = new Set(busyIds.value).add(id)
    try {
      const updated = await action(id)
      if (updated) replaceJob(updated)
      error.value = null
      await refreshNow()
      if (expandedIds.value.has(id) && jobs.value.some((job) => job.id === id)) await loadDetail(id)
      return true
    } catch (cause) {
      error.value = messageOf(cause, fallback)
      return false
    } finally {
      const next = new Set(busyIds.value)
      next.delete(id)
      busyIds.value = next
    }
  }

  const JOB_ACTIONS: Partial<Record<SerialJobAction, [(id: number) => Promise<WebSerialJob | void>, string]>> = {
    cancel: [cancelSerialJob, 'webSerials.api.cancelJob'],
    retry: [retrySerialJob, 'webSerials.api.retryJob'],
    pause: [pauseSerialJob, 'webSerials.api.pauseJob'],
    resume: [resumeSerialJob, 'webSerials.api.resumeJob'],
    moveToTop: [moveSerialJobToTop, 'webSerials.api.moveJob'],
    remove: [removeSerialJob, 'webSerials.api.removeJob'],
  }

  function act(action: SerialJobAction, id: number): Promise<boolean> {
    const entry = JOB_ACTIONS[action]
    return entry ? runJobAction(id, entry[0], entry[1]) : Promise.resolve(false)
  }

  function cancel(id: number): Promise<boolean> {
    return act('cancel', id)
  }

  function retry(id: number): Promise<boolean> {
    return act('retry', id)
  }

  async function retryItem(jobId: number, itemId: number): Promise<boolean> {
    const current = details.value[jobId]
    if (current?.retryingItemIds.has(itemId)) return false
    patchDetail(jobId, { retryingItemIds: new Set(current?.retryingItemIds ?? []).add(itemId) })
    try {
      const detail = await retrySerialJobItem(jobId, itemId)
      replaceJob(detail.job)
      patchDetail(jobId, { items: detail.items, error: null })
      error.value = null
      await refreshNow()
      return true
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.retryItem')
      return false
    } finally {
      const retrying = new Set(details.value[jobId]?.retryingItemIds ?? [])
      retrying.delete(itemId)
      patchDetail(jobId, { retryingItemIds: retrying })
    }
  }

  /** Resolves to how many jobs were removed, or null when it failed. */
  async function clearFinished(): Promise<number | null> {
    if (clearing.value) return null
    clearing.value = true
    try {
      const result = await clearFinishedSerialJobs(scope.value)
      error.value = null
      await refreshNow()
      return result.removed
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.clearFinished')
      return null
    } finally {
      clearing.value = false
    }
  }

  async function setQueuePaused(paused: boolean): Promise<boolean> {
    if (queueBusy.value) return false
    queueBusy.value = true
    try {
      const result = await (paused ? pauseSerialQueue() : resumeSerialQueue())
      queuePaused.value = result.queuePaused
      error.value = null
      await refreshNow()
      return true
    } catch (cause) {
      error.value = messageOf(cause, paused ? 'webSerials.api.pauseQueue' : 'webSerials.api.resumeQueue')
      return false
    } finally {
      queueBusy.value = false
    }
  }

  // Coming back to the list catches up the expanded jobs whose state moved on while it was hidden.
  watch(detailsShown, (shown) => {
    if (shown) void refreshExpandedDetails()
  })

  onBeforeUnmount(stop)

  return {
    jobs,
    activeCount,
    queuePaused,
    scope,
    loading,
    loaded,
    error,
    isEmpty,
    hasMore,
    loadingMore,
    loadMore,
    finishedCount,
    busyIds,
    queueBusy,
    clearing,
    expandedIds,
    details,
    start,
    stop,
    refresh: refreshNow,
    setScope,
    act,
    cancel,
    retry,
    retryItem,
    toggleExpanded,
    clearFinished,
    setQueuePaused,
  }
}
