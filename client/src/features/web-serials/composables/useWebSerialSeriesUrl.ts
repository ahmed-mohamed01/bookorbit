import { onScopeDispose, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { WebSerialCatalogEntry } from '@bookorbit/types'
import { fetchDiscoverEntry } from '../api/webSerials'
import { parseSeriesParam } from '../lib/serialUrl'

export function useWebSerialSeriesUrl(openEntry: (entry: WebSerialCatalogEntry) => void, onError: (cause: unknown) => void) {
  const route = useRoute()
  const router = useRouter()
  let controller: AbortController | undefined
  let generation = 0
  watch(
    [() => route.name, () => route.query.series],
    async ([name, value]) => {
      controller?.abort()
      const mine = ++generation
      if (name !== 'web-serials' || value === undefined) return
      const match = parseSeriesParam(value)
      controller = new AbortController()
      try {
        if (match) {
          const entry = await fetchDiscoverEntry(match.kind, match.matchId, controller.signal)
          if (mine === generation) openEntry(entry)
        }
      } catch (cause) {
        if (mine === generation) onError(cause)
      } finally {
        if (mine === generation) {
          const query = { ...route.query }
          delete query.series
          await router.replace({ name: 'web-serials', query })
        }
      }
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation++
    controller?.abort()
  })
}
