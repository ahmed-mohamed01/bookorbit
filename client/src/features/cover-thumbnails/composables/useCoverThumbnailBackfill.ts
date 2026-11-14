// Fork: cover thumbnail backfill. Admin state for Settings › Fork; polls while a run is going.
import { onScopeDispose, ref } from 'vue'
import type { CoverThumbnailBackfillState } from '@bookorbit/types'

import * as backfillApi from '../api/cover-thumbnails'

export const BACKFILL_POLL_MS = 2000

export function useCoverThumbnailBackfill() {
  const state = ref<CoverThumbnailBackfillState | null>(null)
  const loading = ref(false)
  const acting = ref(false)
  const error = ref<number | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function statusOf(e: unknown): number {
    return e instanceof backfillApi.CoverThumbnailsHttpError ? e.status : 0
  }

  function clearPoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  function apply(next: CoverThumbnailBackfillState): void {
    state.value = next
    clearPoll()
    if (next.running && !disposed) pollTimer = setTimeout(handlePoll, BACKFILL_POLL_MS)
  }

  function handlePoll(): void {
    pollTimer = null
    backfillApi
      .fetchBackfillState()
      .then(apply)
      .catch((e: unknown) => {
        error.value = statusOf(e)
      })
  }

  async function load(): Promise<void> {
    loading.value = state.value === null
    error.value = null
    try {
      apply(await backfillApi.fetchBackfillState())
    } catch (e) {
      error.value = statusOf(e)
    } finally {
      loading.value = false
    }
  }

  async function act(call: () => Promise<CoverThumbnailBackfillState>): Promise<boolean> {
    acting.value = true
    error.value = null
    try {
      apply(await call())
      return true
    } catch (e) {
      error.value = statusOf(e)
      return false
    } finally {
      acting.value = false
    }
  }

  function setEnabled(enabled: boolean): Promise<boolean> {
    return act(() => backfillApi.updateBackfill({ enabled }))
  }

  function runNow(): Promise<boolean> {
    return act(() => backfillApi.runBackfill())
  }

  onScopeDispose(() => {
    disposed = true
    clearPoll()
  })

  return { state, loading, acting, error, load, setEnabled, runNow }
}
