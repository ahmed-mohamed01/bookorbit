import { createRequestGeneration } from '@/lib/async'
import { onScopeDispose, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { WebSerialCatalogEntry } from '@bookorbit/types'
import { fetchDiscoverEntry } from '../api/webSerials'
import { parseSeriesParam } from '../lib/serialUrl'

export function useWebSerialSeriesUrl(openEntry: (entry: WebSerialCatalogEntry) => void, onError: (cause: unknown) => void) {
  const route = useRoute()
  const router = useRouter()
  let controller: AbortController | undefined
  const generation = createRequestGeneration()
  watch(
    [() => route.name, () => route.query.series],
    async ([name, value]) => {
      controller?.abort()
      const mine = generation.begin()
      if (name !== 'web-serials' || value === undefined) return
      const match = parseSeriesParam(value)
      controller = new AbortController()
      try {
        if (match) {
          const entry = await fetchDiscoverEntry(match.kind, match.matchId, controller.signal)
          if (generation.isCurrent(mine)) openEntry(entry)
        }
      } catch (cause) {
        if (generation.isCurrent(mine)) onError(cause)
      } finally {
        if (generation.isCurrent(mine)) {
          const query = { ...route.query }
          delete query.series
          await router.replace({ name: 'web-serials', query })
        }
      }
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation.invalidate()
    controller?.abort()
  })
}
