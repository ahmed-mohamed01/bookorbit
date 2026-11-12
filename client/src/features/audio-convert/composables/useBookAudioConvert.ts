// Fork: Convert to M4B. One book's plan and job for the Files tab button.
import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { AudioConvertEncoderOptions, AudioConvertJob, AudioConvertPlan } from '@bookorbit/types'

import * as audioConvertApi from '../api/audio-convert'
import { isJobActive, pollDelay } from '../lib/audio-convert'

export interface BookAudioConvertOptions {
  /** Called once when a job this page watched ends in success, so the book can refetch its files. */
  onConverted?: (job: AudioConvertJob) => void
  /** Called once when a job this page watched ends in failure, so the page can say so. */
  onFailed?: (job: AudioConvertJob) => void
}

/**
 * Loads the plan for one book, starts or stops its conversion, and polls the plan (which carries
 * the latest job) every two seconds while that job is queued or running, and every thirty seconds
 * while it waits in the automatic pipeline.
 */
export function useBookAudioConvert(bookId: Ref<number | null>, options: BookAudioConvertOptions = {}) {
  const plan = ref<AudioConvertPlan | null>(null)
  const loading = ref(false)
  const loadFailed = ref(false)
  const starting = ref(false)
  const stopping = ref(false)
  const actionError = ref<number | null>(null)

  let token = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const job = computed<AudioConvertJob | null>(() => plan.value?.latestJob ?? null)
  const active = computed(() => isJobActive(job.value))

  function clearPoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  function schedulePoll(): void {
    clearPoll()
    const delay = job.value ? pollDelay([job.value]) : null
    if (disposed || delay === null) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void load()
    }, delay)
  }

  async function load(): Promise<void> {
    const id = bookId.value
    if (id === null) return
    const current = ++token
    const wasActiveJob = active.value ? job.value : null
    if (!plan.value) loading.value = true
    try {
      const next = await audioConvertApi.fetchAudioConvertPlan(id)
      if (current !== token) return
      plan.value = next
      loadFailed.value = false
      const latest = next.latestJob
      if (wasActiveJob && latest && latest.id === wasActiveJob.id) {
        if (latest.status === 'success') options.onConverted?.(latest)
        else if (latest.status === 'failed') options.onFailed?.(latest)
      }
    } catch {
      if (current !== token) return
      loadFailed.value = true
    } finally {
      if (current === token) loading.value = false
    }
    if (current === token) schedulePoll()
  }

  /** `encoder` carries only the fields the user changed; the server uses saved settings for the rest. */
  async function convert(encoder: Partial<AudioConvertEncoderOptions>): Promise<boolean> {
    const id = bookId.value
    if (id === null) return false
    starting.value = true
    actionError.value = null
    try {
      const started = await audioConvertApi.convertBook(id, encoder)
      if (plan.value) {
        plan.value = { ...plan.value, latestJob: started }
        schedulePoll()
      } else {
        void load()
      }
      return true
    } catch (e) {
      actionError.value = e instanceof audioConvertApi.AudioConvertHttpError ? e.status : 0
      return false
    } finally {
      starting.value = false
    }
  }

  async function stop(): Promise<boolean> {
    const id = bookId.value
    if (id === null) return false
    stopping.value = true
    try {
      await audioConvertApi.stopBookConvert(id)
      await load()
      return true
    } catch {
      return false
    } finally {
      stopping.value = false
    }
  }

  watch(
    bookId,
    () => {
      token++
      clearPoll()
      plan.value = null
      loadFailed.value = false
    },
    { flush: 'sync' },
  )

  onUnmounted(() => {
    disposed = true
    clearPoll()
  })

  return { plan, job, active, loading, loadFailed, starting, stopping, actionError, load, convert, stop }
}
