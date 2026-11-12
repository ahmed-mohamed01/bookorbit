// Fork: Convert to M4B. The batch tool's data: paged preview per library, job status polling,
// run/stop, and the waiting pipeline's Skip / Convert now.
import { computed, onActivated, onDeactivated, onUnmounted, ref } from 'vue'
import type {
  AudioConvertEncoderOptions,
  AudioConvertJob,
  AudioConvertPlan,
  AudioConvertPlanStatus,
  AudioConvertPreviewItem,
  AudioConvertRunRequest,
  AudioConvertRunResponse,
  AudioConvertStatus,
} from '@bookorbit/types'

import * as audioConvertApi from '../api/audio-convert'
import { AUDIO_CONVERT_WAITING_POLL_MS, isJobFinished, pollDelay } from '../lib/audio-convert'

/** Why a request failed, as a stable code; the UI owns the wording. */
export interface AudioConvertFailure {
  code: 'http' | 'unknown'
  status?: number
}

export type AudioConvertScope = AudioConvertPlanStatus

export const AUDIO_CONVERT_PAGE_SIZE = 200
export const SEARCH_DEBOUNCE_MS = 250

const EMPTY_COUNTS: Record<AudioConvertPlanStatus, number> = { can_convert: 0, waiting: 0, converted: 0, cannot: 0 }

function toFailure(error: unknown): AudioConvertFailure {
  return error instanceof audioConvertApi.AudioConvertHttpError ? { code: 'http', status: error.status } : { code: 'unknown' }
}

export function useAudioConvert() {
  const selectedLibraryId = ref<number | null>(null)
  const scope = ref<AudioConvertScope>('can_convert')
  const search = ref('')
  /** The search the loaded rows and counts answer to. Trails `search` while a debounced load is pending. */
  const appliedSearch = ref('')

  const items = ref<AudioConvertPreviewItem[]>([])
  const total = ref(0)
  const totalByStatus = ref<Record<AudioConvertPlanStatus, number>>({ ...EMPTY_COUNTS })
  const loading = ref(false)
  const loadingMore = ref(false)
  const previewError = ref<AudioConvertFailure | null>(null)
  /** The first page for this library has answered, so later scope or search loads keep the layout in place. */
  const previewReady = ref(false)

  const status = ref<AudioConvertStatus>({ jobs: [], active: 0 })
  /** The first status answer for this library is in, so the run bar can render without popping in later. */
  const statusReady = ref(false)
  /** Finished jobs the user dismissed from the run bar. */
  const dismissedJobIds = ref<Set<string>>(new Set())

  const running = ref(false)
  const runError = ref<AudioConvertFailure | null>(null)
  const stopping = ref(false)
  /** Job id a Skip / Convert now request is in flight for. */
  const actingJobId = ref<string | null>(null)

  /** Plans fetched for the detail pane, keyed by book. Dropped whenever the preview reloads. */
  const plans = ref<Map<number, AudioConvertPlan>>(new Map())
  const planLoadingId = ref<number | null>(null)
  const planErrorId = ref<number | null>(null)

  let loadToken = 0
  let statusToken = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let paused = false
  /** False until the first status answer for this library, which only seeds what counts as already finished. */
  let statusLoaded = false

  const hasMore = computed(() => items.value.length < total.value)

  function clearPoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  onUnmounted(() => {
    clearPoll()
    if (searchTimer) clearTimeout(searchTimer)
  })
  // The Tools view keeps tabs alive; a hidden tab should not keep polling.
  onDeactivated(() => {
    paused = true
    clearPoll()
  })
  onActivated(() => {
    if (!paused) return
    paused = false
    if (selectedLibraryId.value !== null) void refreshStatus()
  })

  async function fetchPage(page: number): Promise<void> {
    const libraryId = selectedLibraryId.value
    if (libraryId === null) return

    const token = ++loadToken
    if (page === 1) {
      loading.value = true
      previewError.value = null
    } else {
      loadingMore.value = true
    }

    try {
      const query = search.value
      const result = await audioConvertApi.fetchAudioConvertPreview(libraryId, page, AUDIO_CONVERT_PAGE_SIZE, scope.value, query)
      if (token !== loadToken) return
      if (page === 1) appliedSearch.value = query.trim()
      items.value = page === 1 ? result.items : [...items.value, ...result.items]
      total.value = result.total
      totalByStatus.value = result.totalByStatus
    } catch (e) {
      if (token !== loadToken) return
      previewError.value = toFailure(e)
      if (page === 1) {
        items.value = []
        total.value = 0
      }
    } finally {
      if (token === loadToken) {
        loading.value = false
        loadingMore.value = false
        previewReady.value = true
      }
    }
  }

  function loadPreview(): Promise<void> {
    return fetchPage(1)
  }

  function loadMore(): Promise<void> {
    if (loading.value || loadingMore.value || !hasMore.value) return Promise.resolve()
    return fetchPage(Math.floor(items.value.length / AUDIO_CONVERT_PAGE_SIZE) + 1)
  }

  function schedulePoll(): void {
    clearPoll()
    if (paused || status.value.active <= 0) return
    // Two seconds while a job is queued or running; waiting jobs can sit for a day, so slowly then.
    const delay = pollDelay(status.value.jobs) ?? AUDIO_CONVERT_WAITING_POLL_MS
    pollTimer = setTimeout(() => {
      pollTimer = null
      void refreshStatus()
    }, delay)
  }

  /**
   * Polls while anything is active (see {@link schedulePoll}) and stops once the server reports idle. A job
   * finishing changes which scope its book belongs to, so the preview reloads when one does.
   */
  async function refreshStatus(): Promise<void> {
    const libraryId = selectedLibraryId.value
    if (libraryId === null) return
    const token = ++statusToken
    const before = finishedIds(status.value.jobs)
    try {
      const next = await audioConvertApi.fetchAudioConvertStatus(libraryId)
      if (token !== statusToken || libraryId !== selectedLibraryId.value) return
      status.value = next
      const fresh = next.jobs.filter((job) => finishedIds([job]).size > 0 && !before.has(job.id))
      if (statusLoaded && fresh.length > 0) {
        forgetPlans(fresh.map((job) => job.bookId))
        void loadPreview()
      }
      statusLoaded = true
    } catch {
      // A failed poll keeps the last known state; the next tick tries again while anything was active.
    }
    if (token === statusToken && libraryId === selectedLibraryId.value) statusReady.value = true
    if (token === statusToken) schedulePoll()
  }

  /** A finished job changes a book's files, so its cached plan no longer describes it. */
  function forgetPlans(bookIds: number[]): void {
    const next = new Map(plans.value)
    for (const id of bookIds) next.delete(id)
    plans.value = next
  }

  function finishedIds(jobs: AudioConvertJob[]): Set<string> {
    return new Set(jobs.filter(isJobFinished).map((job) => job.id))
  }

  function selectLibrary(libraryId: number): void {
    selectedLibraryId.value = libraryId
    scope.value = 'can_convert'
    search.value = ''
    appliedSearch.value = ''
    items.value = []
    total.value = 0
    totalByStatus.value = { ...EMPTY_COUNTS }
    status.value = { jobs: [], active: 0 }
    dismissedJobIds.value = new Set()
    plans.value = new Map()
    runError.value = null
    clearPoll()
    statusToken++
    statusLoaded = false
    statusReady.value = false
    previewReady.value = false
  }

  function setSearch(next: string): void {
    if (search.value === next) return
    search.value = next
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      items.value = []
      total.value = 0
      void loadPreview()
    }, SEARCH_DEBOUNCE_MS)
  }

  function setScope(next: AudioConvertScope): void {
    if (scope.value === next) return
    scope.value = next
    items.value = []
    total.value = 0
    void loadPreview()
  }

  async function loadPlan(bookId: number, force = false): Promise<void> {
    if (!force && plans.value.has(bookId)) return
    planLoadingId.value = bookId
    planErrorId.value = null
    try {
      const plan = await audioConvertApi.fetchAudioConvertPlan(bookId)
      const next = new Map(plans.value)
      next.set(bookId, plan)
      plans.value = next
    } catch {
      if (planLoadingId.value === bookId) planErrorId.value = bookId
    } finally {
      if (planLoadingId.value === bookId) planLoadingId.value = null
    }
  }

  /** `options` carries only the encoder fields the user changed; the server uses saved settings for the rest. */
  async function run(selection: AudioConvertRunRequest, options: Partial<AudioConvertEncoderOptions> = {}): Promise<AudioConvertRunResponse | null> {
    const libraryId = selectedLibraryId.value
    if (libraryId === null) return null
    running.value = true
    runError.value = null
    try {
      const result = await audioConvertApi.runAudioConvert(libraryId, { ...selection, ...options })
      // A new run starts a fresh bar: finished jobs from earlier runs make way for it.
      dismissFinished()
      await refreshStatus()
      await loadPreview()
      return result
    } catch (e) {
      runError.value = toFailure(e)
      return null
    } finally {
      running.value = false
    }
  }

  /** Cancels queued jobs; the book being converted finishes. */
  async function stop(): Promise<number | null> {
    const libraryId = selectedLibraryId.value
    if (libraryId === null) return null
    stopping.value = true
    try {
      const result = await audioConvertApi.stopAudioConvert(libraryId)
      await refreshStatus()
      return result.cancelled
    } catch {
      return null
    } finally {
      stopping.value = false
    }
  }

  async function actOnJob(job: AudioConvertJob, action: 'skip' | 'convertNow'): Promise<boolean> {
    actingJobId.value = job.id
    try {
      if (action === 'skip') await audioConvertApi.skipAudioConvertJob(job.id)
      else await audioConvertApi.convertAudioConvertJobNow(job.id)
      forgetPlans([job.bookId])
      await Promise.all([refreshStatus(), loadPreview()])
      return true
    } catch {
      return false
    } finally {
      actingJobId.value = null
    }
  }

  function skipJob(job: AudioConvertJob): Promise<boolean> {
    return actOnJob(job, 'skip')
  }

  function convertJobNow(job: AudioConvertJob): Promise<boolean> {
    return actOnJob(job, 'convertNow')
  }

  /** Jobs the run bar follows: queued, running, or finished and not yet dismissed. Waiting jobs live in their own scope. */
  const runJobs = computed<AudioConvertJob[]>(() =>
    status.value.jobs
      .filter((job) => job.status !== 'waiting' && !dismissedJobIds.value.has(job.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  )

  function dismissFinished(): void {
    const next = new Set(dismissedJobIds.value)
    for (const job of runJobs.value) if (job.status !== 'queued' && job.status !== 'running') next.add(job.id)
    dismissedJobIds.value = next
  }

  return {
    selectedLibraryId,
    scope,
    search,
    appliedSearch,
    items,
    total,
    totalByStatus,
    hasMore,
    loading,
    loadingMore,
    previewError,
    previewReady,

    status,
    statusReady,
    runJobs,
    running,
    runError,
    stopping,
    actingJobId,

    plans,
    planLoadingId,
    planErrorId,

    selectLibrary,
    setSearch,
    setScope,
    loadPreview,
    loadMore,
    loadPlan,
    refreshStatus,
    run,
    stop,
    skipJob,
    convertJobNow,
    dismissFinished,
  }
}
