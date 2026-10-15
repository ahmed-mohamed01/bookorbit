import { computed, ref } from 'vue'
import type { MoveWebSerialJobResult, WebSerialJob, WebSerialMoveCandidate, WebSerialMoveCandidates } from '@bookorbit/types'
import { fetchMoveCandidates, moveSerialJob } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

export function useWebSerialMove() {
  const job = ref<WebSerialJob | null>(null)
  const result = ref<WebSerialMoveCandidates | null>(null)
  const loading = ref(false)
  const moving = ref(false)
  const error = ref<string | null>(null)
  const selectedKey = ref<string | null>(null)

  let controller: AbortController | null = null

  const selected = computed<WebSerialMoveCandidate | null>(
    () => result.value?.candidates.find((candidate) => candidate.seriesKey === selectedKey.value) ?? null,
  )
  const isEmpty = computed(() => result.value !== null && result.value.candidates.length === 0)

  function reset(): void {
    controller?.abort()
    controller = null
    job.value = null
    result.value = null
    loading.value = false
    moving.value = false
    error.value = null
    selectedKey.value = null
  }

  async function load(target: WebSerialJob): Promise<void> {
    reset()
    job.value = target
    loading.value = true
    const mine = new AbortController()
    controller = mine
    try {
      const candidates = await fetchMoveCandidates(target.id, mine.signal)
      if (mine.signal.aborted) return
      result.value = candidates
      selectedKey.value = candidates.candidates[0]?.seriesKey ?? null
    } catch (cause) {
      if (mine.signal.aborted) return
      error.value = messageOf(cause, 'webSerials.api.otherSources')
    } finally {
      if (controller === mine) loading.value = false
    }
  }

  function select(seriesKey: string): void {
    if (!moving.value) selectedKey.value = seriesKey
  }

  /** Resolves to the move result, or null when it failed (the reason is in `error`). */
  async function confirm(): Promise<MoveWebSerialJobResult | null> {
    const target = job.value
    const choice = selected.value
    if (!target || !choice || moving.value) return null
    moving.value = true
    error.value = null
    try {
      return await moveSerialJob(target.id, { seriesKey: choice.seriesKey })
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.moveJob')
      return null
    } finally {
      moving.value = false
    }
  }

  return { job, result, loading, moving, error, selectedKey, selected, isEmpty, load, select, confirm, reset }
}
