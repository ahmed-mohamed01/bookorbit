import { ref, watch, type Ref } from 'vue'
import type { WebSerialSourceOption } from '@bookorbit/types'
import { fetchSeriesSources } from '../api/webSerials'

export type WebSerialSourcesState = 'idle' | 'loading' | 'ready' | 'error'

/** Other sources carrying the previewed series. Loads without blocking the preview and never raises: a failure just hides the choice. */
export function useWebSerialSources(seriesKey: Ref<string | null>) {
  const options = ref<WebSerialSourceOption[]>([])
  const state = ref<WebSerialSourcesState>('idle')
  let token = 0
  let controller: AbortController | null = null

  async function load(key: string | null): Promise<void> {
    const mine = ++token
    controller?.abort()
    controller = null
    options.value = []
    if (!key) {
      state.value = 'idle'
      return
    }
    state.value = 'loading'
    controller = new AbortController()
    try {
      const result = await fetchSeriesSources(key, controller.signal)
      if (mine !== token) return
      options.value = result.options
      state.value = 'ready'
    } catch {
      if (mine !== token) return
      state.value = 'error'
    }
  }

  watch(seriesKey, (key) => void load(key), { immediate: true })

  return { options, state }
}
