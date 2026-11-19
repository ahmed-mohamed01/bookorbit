// Fork: cover thumbnail backfill. Admin state for Settings › Fork; follows the Jobs push while a run is going.
import { onScopeDispose, ref } from 'vue'
import type { CoverThumbnailBackfillState } from '@bookorbit/types'

import { followJobType } from '@/features/jobs/lib/follow-job-type'

import * as backfillApi from '../api/cover-thumbnails'

export function useCoverThumbnailBackfill() {
  const state = ref<CoverThumbnailBackfillState | null>(null)
  const loading = ref(false)
  const acting = ref(false)
  const error = ref<number | null>(null)
  let stopFollowing: (() => void) | null = null
  let disposed = false

  function statusOf(e: unknown): number {
    return e instanceof backfillApi.CoverThumbnailsHttpError ? e.status : 0
  }

  function unfollow(): void {
    stopFollowing?.()
    stopFollowing = null
  }

  function running(): boolean {
    return state.value?.running != null
  }

  function apply(next: CoverThumbnailBackfillState): void {
    state.value = next
    if (!next.running || disposed) return unfollow()
    stopFollowing ??= followJobType('cover-thumbnail-backfill', refresh, running)
  }

  function refresh(): Promise<void> {
    return backfillApi
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
    unfollow()
  })

  return { state, loading, acting, error, load, setEnabled, runNow }
}
