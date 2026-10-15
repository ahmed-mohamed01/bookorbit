import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import type { WebSerialNovelIndexStatus } from '@bookorbit/types'
import { fetchNovelIndexStatus, runNovelIndexAction } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

const POLL_MS = 5_000

export type NovelIndexAction = 'fill' | 'rebuild'

/** The admin view of the light novel index: per-source fill state, refreshed while a source is being indexed. */
export function useWebSerialNovelIndex() {
  const status = ref<WebSerialNovelIndexStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const busy = reactive<Record<string, NovelIndexAction>>({})
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const active = computed(() => status.value?.sources.some((source) => source.running) ?? false)

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!disposed && active.value) timer = setTimeout(() => void load(true), POLL_MS)
  }

  async function load(quiet = false): Promise<void> {
    if (!quiet) loading.value = true
    error.value = null
    try {
      status.value = await fetchNovelIndexStatus()
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.novelIndex')
    } finally {
      loading.value = false
      schedule()
    }
  }

  async function act(sourceId: string, action: NovelIndexAction): Promise<boolean> {
    if (busy[sourceId]) return false
    busy[sourceId] = action
    error.value = null
    try {
      status.value = await runNovelIndexAction(sourceId, action)
      return true
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.indexAction')
      return false
    } finally {
      delete busy[sourceId]
      schedule()
    }
  }

  function dispose(): void {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  onBeforeUnmount(dispose)

  return { status, loading, error, busy, active, load, act, dispose }
}
